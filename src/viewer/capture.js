/**
 * Screenshots, full-page stitching and video recording.
 *
 * Split out of viewer.js, which had grown to span geometry, capture, emulation
 * and UI wiring at once. Everything it needs from the viewer arrives through a
 * context object, so this file holds no state beyond the recorder.
 */

import { capturedPerPagePx } from './geometry.js';

/** Beyond this a stitched page becomes unwieldy and the canvas risks failing. */
const MAX_CAPTURE_HEIGHT = 20000;

/** Files are named after the site being viewed, then the devices. */
export function fileStem(url, devices, suffix) {
  let host = 'page';
  try {
    host = new URL(url).hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]+/gi, '-');
  } catch {
    /* no URL yet */
  }
  const ids = devices.map((d) => d.id).join('+');
  return `${host || 'page'}-${ids}-${suffix}`;
}

const nextFrames = () =>
  new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

/**
 * @param ctx {
 *   stage, panesEl,             // elements
 *   panes(), devices(),         // current state
 *   url(), rotated(),
 *   zoom: { get(), set(mode) }, // stage zoom, 'fit' or a number string
 *   currentZoom(), layout(),
 *   capture(),                  // resolves to an Image of the visible tab
 *   streamId(),                 // resolves to a tabCapture stream id or null
 *   measure(pane),              // page scroll metrics
 *   send(pane, message),        // postMessage into a framed page
 *   flash(message, warn),
 *   onRecordingChange(active),
 * }
 */
export function createCapture(ctx) {
  let recorder = null;
  let stopRecorder = null;

  /**
   * The devices' footprint on screen.
   *
   * Deliberately the union of the panes rather than the container's own box: the
   * container also holds the dashed "Add device" tile, which must not appear in
   * a screenshot or a recording.
   */
  function paneRect() {
    const rects = [...ctx.panesEl.querySelectorAll('.pane')].map((p) =>
      p.getBoundingClientRect(),
    );
    if (!rects.length) return ctx.panesEl.getBoundingClientRect();
    const left = Math.min(...rects.map((r) => r.left));
    const top = Math.min(...rects.map((r) => r.top));
    const right = Math.max(...rects.map((r) => r.right));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  /**
   * Run at the largest zoom that keeps the capture target fully on screen.
   *
   * captureVisibleTab can only see the window, so anything off it is clipped and
   * the result has to be downscaled. 100% is tried first, then the target is
   * scrolled into view, and only then does it fall back to shrinking.
   *
   * `target` matters: a whole-device shot needs the bezel visible, but a
   * full-page capture only needs the page area, which fits at 1:1 far more often.
   */
  async function withCaptureZoom(run, { target = paneRect, reveal } = {}) {
    const previous = ctx.zoom.get();
    const overflows = () => {
      const box = target();
      const stage = ctx.stage.getBoundingClientRect();
      return (
        box.top < stage.top - 1 ||
        box.bottom > stage.bottom + 1 ||
        box.left < stage.left - 1 ||
        box.right > stage.right + 1
      );
    };
    const apply = async (mode) => {
      ctx.zoom.set(mode);
      ctx.layout();
      await nextFrames();
      await new Promise((r) => setTimeout(r, 120));
    };
    const settle = async () => {
      reveal?.();
      await nextFrames();
    };

    if (ctx.zoom.get() !== '1') await apply('1');
    await settle();
    if (overflows()) {
      await apply('fit');
      await settle();
    }
    try {
      return await run();
    } finally {
      if (previous !== ctx.zoom.get()) await apply(previous);
    }
  }

  const name = (suffix) => fileStem(ctx.url(), ctx.devices(), suffix);

  function download(canvas, suffix) {
    const link = document.createElement('a');
    link.download = `${name(suffix)}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  }

  /** The devices as they appear now, bezels included. */
  async function screenshot() {
    try {
      await withCaptureZoom(async () => {
        const rect = paneRect();
        const img = await ctx.capture();
        const scale = img.width / window.innerWidth;
        const sx = Math.max(0, rect.left * scale);
        const sy = Math.max(0, rect.top * scale);
        const sw = Math.min(rect.width * scale, img.width - sx);
        const sh = Math.min(rect.height * scale, img.height - sy);

        const canvas = document.createElement('canvas');
        canvas.width = Math.round(sw);
        canvas.height = Math.round(sh);
        canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
        download(canvas, ctx.rotated() ? 'landscape' : 'portrait');
        ctx.flash('Screenshot saved');
      });
    } catch (err) {
      ctx.flash(`Screenshot failed: ${err.message}`, true);
    }
  }

  /**
   * Full-length page capture of the leading pane: scroll the framed document a
   * viewport at a time, capture each, and stitch. Only the page area is
   * captured, not the bezel, because a repeated bezel down a long strip is
   * meaningless.
   */
  async function fullPageScreenshot() {
    const pane = ctx.panes()[0];
    if (!pane) return;

    try {
      // Only the page area has to be on screen, so this usually captures at 1:1.
      const options = {
        target: () => pane.screen.getBoundingClientRect(),
        reveal: () => pane.screen.scrollIntoView({ block: 'center', inline: 'center' }),
      };
      await withCaptureZoom(async () => {
        const metrics = await ctx.measure(pane);
        if (!metrics) throw new Error('the page did not report its size');

        const pageH = metrics.innerHeight;
        const total = Math.min(metrics.scrollHeight, MAX_CAPTURE_HEIGHT);
        const steps = Math.max(1, Math.ceil(total / pageH));
        ctx.flash(`Capturing ${steps} screen${steps === 1 ? '' : 's'}…`);

        // Pause animations and pin fixed elements, or a sticky header repeats in
        // every slice; drop the bezel so its rounded corners cannot either.
        ctx.send(pane, { __gonbi: 'freeze', on: true });
        pane.frame.classList.add('is-capturing');
        await nextFrames();
        await new Promise((r) => setTimeout(r, 150));

        const rect = pane.screen.getBoundingClientRect();
        let canvas = null;
        let context = null;

        try {
          for (let step = 0; step < steps; step++) {
            const y = Math.min(step * pageH, Math.max(0, total - pageH));
            ctx.send(pane, { __gonbi: 'scrollTo', x: 0, y });
            await nextFrames();
            await new Promise((r) => setTimeout(r, 260));

            const img = await ctx.capture();

            /*
             * Two different units meet here. `rect` is the iframe's box on
             * screen, so it already includes the stage zoom; `y` and `total` are
             * page CSS pixels, which do not. Forgetting the zoom term spaced the
             * slices out on an over-tall canvas and left gaps between them.
             */
            const shot = img.width / window.innerWidth;
            const perPagePx = capturedPerPagePx(shot, ctx.currentZoom());

            if (!canvas) {
              canvas = document.createElement('canvas');
              canvas.width = Math.round(rect.width * shot);
              canvas.height = Math.round(total * perPagePx);
              context = canvas.getContext('2d');
            }
            context.drawImage(
              img,
              rect.left * shot,
              rect.top * shot,
              rect.width * shot,
              rect.height * shot,
              0,
              Math.round(y * perPagePx),
              rect.width * shot,
              rect.height * shot,
            );
          }
        } finally {
          // Restore the frame even if a capture pass threw.
          pane.frame.classList.remove('is-capturing');
          ctx.send(pane, { __gonbi: 'freeze', on: false });
          ctx.send(pane, { __gonbi: 'scrollTo', x: 0, y: metrics.scrollY });
        }

        download(canvas, `fullpage-${Math.round(total)}px`);
        const clipped = metrics.scrollHeight > MAX_CAPTURE_HEIGHT;
        // Say so when the window forced a downscale, rather than quietly handing
        // back an image narrower than the device.
        const scaled =
          ctx.currentZoom() < 0.995
            ? ` at ${Math.round(ctx.currentZoom() * 100)}%`
            : '';
        ctx.flash(
          clipped
            ? `Saved - page was longer than ${MAX_CAPTURE_HEIGHT}px and was cut off`
            : `Full page saved (${Math.round(total)}px tall${scaled})`,
          clipped,
        );
      }, options);
    } catch (err) {
      ctx.flash(`Full-page capture failed: ${err.message}`, true);
    }
  }

  /**
   * A stream of this tab.
   *
   * tabCapture is frictionless but needs activeTab access to the viewer tab,
   * which the extension only has if it was invoked there - opening the viewer
   * ourselves does not grant it. So it is tried first and getDisplayMedia, which
   * costs the user one confirmation, is the fallback.
   */
  async function tabStream() {
    const streamId = await ctx.streamId();
    if (streamId) {
      try {
        return await navigator.mediaDevices.getUserMedia({
          video: {
            mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
          },
        });
      } catch {
        /* fall through to the picker */
      }
    }
    return navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser' },
      preferCurrentTab: true,
      audio: false,
    });
  }

  async function startRecording() {
    const stream = await tabStream();

    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();

    const rect = paneRect();
    const scale = video.videoWidth / window.innerWidth;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(rect.width * scale);
    canvas.height = Math.round(rect.height * scale);
    const context = canvas.getContext('2d');

    let running = true;
    const draw = () => {
      if (!running) return;
      // Crop the tab capture down to the devices on every frame.
      context.drawImage(
        video,
        rect.left * scale,
        rect.top * scale,
        rect.width * scale,
        rect.height * scale,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      requestAnimationFrame(draw);
    };
    draw();

    const chunks = [];
    recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm' });
    recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
    recorder.onstop = () => {
      running = false;
      stream.getTracks().forEach((track) => track.stop());
      const link = document.createElement('a');
      link.download = `${name('recording')}.webm`;
      link.href = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    };
    recorder.start();

    const startedAt = performance.now();
    const tick = setInterval(() => {
      const seconds = Math.floor((performance.now() - startedAt) / 1000);
      const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
      const ss = String(seconds % 60).padStart(2, '0');
      ctx.onRecordingChange(true, `Recording ${mm}:${ss} - press V to stop`);
    }, 500);

    stopRecorder = () => {
      clearInterval(tick);
      recorder?.stop();
      recorder = null;
      stopRecorder = null;
    };
    ctx.onRecordingChange(true, 'Recording 00:00 - press V to stop');
  }

  function stopRecording() {
    stopRecorder?.();
    ctx.onRecordingChange(false);
  }

  return {
    paneRect,
    screenshot,
    fullPageScreenshot,
    toggleRecording: () =>
      recorder
        ? stopRecording()
        : startRecording().catch((err) =>
            ctx.flash(`Recording failed: ${err.message}`, true),
          ),
    isRecording: () => !!recorder,
    name,
  };
}
