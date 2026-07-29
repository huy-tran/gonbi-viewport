/**
 * Where the frame, the bezel art and the page sit, in unscaled CSS pixels.
 *
 * Kept pure and free of DOM access so it can be unit tested. It has carried two
 * real bugs already - a square iframe poking its corners out past the device
 * silhouette, and screen pixels mixed with page pixels during capture - both of
 * which a test could have caught.
 */

import { chromeFor, isRotatable } from '../lib/device-chrome.js';

/**
 * @param device   catalogue entry
 * @param frame    FRAME_GEOMETRY entry for the device, or undefined
 * @param state    { index, rotated, showFrame, showDeviceUi, customSize }
 */
export function computeGeometry(device, frame, state) {
  const { index = 0, rotated = false, showFrame = true, showDeviceUi = true } = state;
  // A custom size applies to the leading pane only, so a comparison can hold a
  // free-size viewport next to real devices.
  const customSize = index === 0 ? state.customSize : null;

  const canRotate = isRotatable(device) || !!customSize;
  const turned = rotated && canRotate;

  const natural = customSize ?? { w: device.width, h: device.height };
  const viewport = turned
    ? { w: natural.h, h: natural.w }
    : { w: natural.w, h: natural.h };

  const withUi = (base) => {
    const ui = showDeviceUi
      ? chromeFor(device, base.turned)
      : { top: null, bottom: null };
    const top = ui.top?.height ?? 0;
    const bottom = ui.bottom?.height ?? 0;
    return {
      ...base,
      ui,
      page: {
        y: top,
        w: base.screen.w,
        h: Math.max(0, base.screen.h - top - bottom),
      },
    };
  };

  const bare = {
    box: viewport,
    screen: { x: 0, y: 0, ...viewport },
    art: null,
    radius: 0,
    turned,
  };

  // No bezel fits an arbitrary size, so a custom pane always renders bare.
  if (!showFrame || customSize || !frame) return withUi(bare);

  // Natural-orientation frame that makes the cutout exactly device-sized.
  const fW = device.width / (frame.screen.widthPct / 100);
  const fH = device.height / (frame.screen.heightPct / 100);
  const sx = (fW * frame.screen.leftPct) / 100;
  const sy = (fH * frame.screen.topPct) / 100;

  // The cutout is a rounded rectangle, and on most phones its bounding-box
  // corners sit right on the device's outer curve. A square iframe filling that
  // box would poke its corners out past the silhouette, so it is clipped to the
  // same radius. Scaled off the unrotated width, because the physical corner
  // radius does not change when the device is turned.
  const radius = (frame.screen.radiusPct / 100) * device.width;

  if (!turned) {
    return withUi({
      box: { w: fW, h: fH },
      screen: { x: sx, y: sy, w: device.width, h: device.height },
      art: { w: fW, h: fH, rotate: false },
      radius,
      turned,
    });
  }

  // 90deg clockwise: a point (x, y) becomes (fH - y, x).
  return withUi({
    box: { w: fH, h: fW },
    screen: {
      x: fH - sy - device.height,
      y: sx,
      w: device.height,
      h: device.width,
    },
    art: { w: fW, h: fH, rotate: true },
    radius,
    turned,
  });
}

/**
 * One zoom for every pane, so a comparison stays to scale.
 * `avail` is the space the stage can give them.
 */
export function fitZoom(boxes, avail) {
  if (!boxes.length) return 1;
  const totalW = boxes.reduce((sum, b) => sum + b.w, 0);
  const tallest = Math.max(...boxes.map((b) => b.h));
  return Math.min(1, avail.w / totalW, avail.h / tallest);
}

/**
 * Captured pixels per page CSS pixel.
 *
 * `shot` is captured pixels per screen pixel; the stage zoom sits between screen
 * pixels and the page's own. Dropping the zoom term is what once spaced stitched
 * slices apart on an over-tall canvas.
 */
export const capturedPerPagePx = (shot, zoom) => shot * zoom;
