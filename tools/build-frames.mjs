/**
 * Draws every device frame as an SVG, from the catalogue's own dimensions.
 *
 * This replaces the third-party device photography an earlier revision used,
 * which could not be redistributed. Bezel thickness and corner radius come from
 * the device's viewport and class - facts about the hardware - so the output is
 * original work.
 *
 * The screen is a real hole - an outer rounded rect and an inner one in a single
 * even-odd path - so the viewer can keep layering the frame *above* the iframe
 * and letting the page show through, exactly as it did with the keyed PNGs.
 *
 * Emits assets/frames/<device-id>.svg and src/data/frame-geometry.js.
 *
 * Run: node tools/build-frames.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEVICES } from '../src/data/devices.js';
import { chromeFor } from '../src/lib/device-chrome.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'assets', 'frames');

const BODY = '#2b2f38';
const BODY_EDGE = '#12151b';
const BODY_LIGHT = '#3d434f';
const DETAIL = '#0d1014';
const METAL = '#9aa1ad';

const round = (n) => Math.round(n * 100) / 100;

/** A rounded-rectangle path, drawn clockwise. */
function rect(x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  return [
    `M${round(x + rad)},${round(y)}`,
    `H${round(x + w - rad)}`,
    `a${round(rad)},${round(rad)} 0 0 1 ${round(rad)},${round(rad)}`,
    `V${round(y + h - rad)}`,
    `a${round(rad)},${round(rad)} 0 0 1 ${round(-rad)},${round(rad)}`,
    `H${round(x + rad)}`,
    `a${round(rad)},${round(rad)} 0 0 1 ${round(-rad)},${round(-rad)}`,
    `V${round(y + rad)}`,
    `a${round(rad)},${round(rad)} 0 0 1 ${round(rad)},${round(-rad)}`,
    'Z',
  ].join(' ');
}

/**
 * Bezel metrics per device class.
 *
 * A notched phone has a thin uniform bezel and a big screen radius; a
 * home-button phone has a forehead and chin and square screen corners. Laptops
 * carry a chin and a base. These proportions are read off the real hardware.
 */
function metrics(device) {
  const { width: w, height: h, category } = device;
  const short = Math.min(w, h);
  const long = Math.max(w, h);

  if (category === 'laptop') {
    const side = Math.max(8, Math.round(w * 0.011));
    return {
      kind: 'laptop',
      top: Math.max(10, Math.round(w * 0.014)),
      bottom: Math.max(20, Math.round(w * 0.026)),
      side,
      radius: 3,
    };
  }

  if (category === 'desktop') {
    const tv = /SMART-TV/.test(device.ua);
    const side = Math.max(6, Math.round(w * (tv ? 0.006 : 0.012)));
    return {
      kind: tv ? 'tv' : 'imac',
      top: side,
      bottom: Math.max(side, Math.round(w * (tv ? 0.012 : 0.05))),
      side,
      radius: 3,
    };
  }

  if (category === 'tablet') {
    // The 4:3 generation had a thick bezel and square screen corners. No home
    // button is drawn: on a landscape frame it would sit along the bottom edge,
    // which is not where it is on the hardware.
    const modern = long / short >= 1.4;
    const bezel = Math.round(short * (modern ? 0.035 : 0.075));
    return {
      kind: 'tablet',
      top: bezel,
      bottom: bezel,
      side: bezel,
      radius: modern ? Math.round(short * 0.022) : 3,
    };
  }

  /*
   * Phones. Aspect ratio alone misreads foldables - a Galaxy Fold is 1.25 and
   * has no home button - so the forehead-and-chin treatment is reserved for the
   * Apple devices that actually had one. Nothing Android in the catalogue does.
   */
  const apple = /iPhone/.test(device.ua);
  const notched = !apple || long / short >= 1.9;
  if (notched) {
    const bezel = Math.max(8, Math.round(w * 0.028));
    return {
      kind: 'phone',
      top: bezel,
      bottom: bezel,
      side: bezel,
      radius: Math.round(w * 0.145),
      // An Apple pill, or the small punch-hole every Android here actually has.
      camera: apple ? 'pill' : 'hole',
      buttons: true,
    };
  }
  return {
    kind: 'phone',
    top: Math.round(w * 0.13),
    bottom: Math.round(w * 0.155),
    side: Math.max(6, Math.round(w * 0.032)),
    radius: 3,
    homeButton: true,
    speaker: true,
    buttons: true,
  };
}

/**
 * The camera cluster drawn over the top of the screen, in screen-relative
 * coordinates, or null if the device has none.
 *
 * Sized from the status bar that src/lib/device-chrome.js declares rather than
 * from the viewport, because the two have to agree: the first version scaled a
 * pill off the device width and drew a 32px Apple-style island on Android
 * phones whose status bar is only 24px, so it hung down into the page. Deriving
 * it from the bar makes the fit structural, and the unit tests assert it.
 */
export function topFurniture(device) {
  const m = metrics(device);
  if (!m.camera) return null;
  const bar = chromeFor(device, false).top?.height ?? 0;
  if (!bar) return null;

  if (m.camera === 'pill') {
    // Roughly Apple's proportions, but never taller than fits in the bar.
    const h = Math.min(Math.round(device.width * 0.09), Math.round(bar * 0.62));
    const w = Math.round(device.width * 0.3);
    return { kind: 'pill', w, h, y: Math.round((bar - h) / 2) };
  }

  const d = Math.min(Math.round(device.width * 0.032), Math.round(bar * 0.42));
  return { kind: 'hole', w: d, h: d, y: Math.round((bar - d) / 2) };
}

/** Frame box and where the screen sits inside it. */
function layout(device) {
  const m = metrics(device);
  const screen = {
    x: m.side,
    y: m.top,
    w: device.width,
    h: device.height,
    r: m.radius,
  };
  const frame = { w: device.width + m.side * 2, h: device.height + m.top + m.bottom };
  return { m, screen, frame };
}

/**
 * How far the drawing reaches outside the device body on each side.
 *
 * Side buttons and a laptop base both extend past the body, and the canvas has
 * to make room or the viewBox silently clips them.
 */
function overhangs(device, m, body) {
  const stud = m.buttons ? Math.max(2, Math.round(m.side * 0.35)) : 0;
  const base = m.kind === 'laptop' ? Math.round(body.w * 0.045) : 0;
  return { left: Math.max(stud, base), right: Math.max(stud, base) };
}

function draw(device) {
  const { m, screen: inner, frame: body } = layout(device);
  const pad = overhangs(device, m, body);
  const parts = [];
  const outerRadius = m.radius + Math.min(m.side, m.top);

  // Everything is drawn shifted right by pad.left, so nothing sits at negative x.
  const ox = pad.left;
  const cx = ox + body.w / 2;
  const screen = { ...inner, x: inner.x + ox };

  // Body with the screen punched out, so the page shows through the hole.
  parts.push(
    `<path fill="${BODY}" fill-rule="evenodd" d="${rect(ox, 0, body.w, body.h, outerRadius)} ${rect(
      screen.x,
      screen.y,
      screen.w,
      screen.h,
      screen.r,
    )}"/>`,
  );
  // A hairline inside the bezel reads as the glass edge.
  parts.push(
    `<path fill="none" stroke="${BODY_EDGE}" stroke-width="1" d="${rect(
      screen.x - 1,
      screen.y - 1,
      screen.w + 2,
      screen.h + 2,
      screen.r + 1,
    )}"/>`,
  );
  parts.push(
    `<path fill="none" stroke="${BODY_LIGHT}" stroke-width="1" opacity=".5" d="${rect(
      ox + 0.5,
      0.5,
      body.w - 1,
      body.h - 1,
      outerRadius,
    )}"/>`,
  );

  const camera = topFurniture(device);
  if (camera) {
    parts.push(
      `<rect x="${round(cx - camera.w / 2)}" y="${round(screen.y + camera.y)}" ` +
        `width="${camera.w}" height="${camera.h}" rx="${round(camera.h / 2)}" fill="${DETAIL}"/>`,
    );
  }

  if (m.speaker) {
    const sw = Math.round(device.width * 0.16);
    const sh = Math.max(3, Math.round(device.width * 0.012));
    parts.push(
      `<rect x="${round(cx - sw / 2)}" y="${round(m.top / 2 - sh / 2)}" width="${sw}" height="${sh}" rx="${round(sh / 2)}" fill="${DETAIL}"/>`,
    );
  }

  if (m.homeButton) {
    const r = Math.round(Math.min(m.bottom, device.width * 0.09) * 0.42);
    parts.push(
      `<circle cx="${round(cx)}" cy="${round(screen.y + screen.h + m.bottom / 2)}" r="${r}" fill="none" stroke="${BODY_LIGHT}" stroke-width="2"/>`,
    );
  }

  if (m.buttons) {
    const bw = Math.max(2, Math.round(m.side * 0.35));
    const unit = device.height;
    const add = (x, y, h) =>
      parts.push(
        `<rect x="${round(x)}" y="${round(y)}" width="${bw}" height="${round(h)}" rx="${round(bw / 2)}" fill="${BODY_LIGHT}"/>`,
      );
    // Volume pair on the left, power on the right, roughly where they really are.
    add(ox - bw + 1, screen.y + unit * 0.16, unit * 0.07);
    add(ox - bw + 1, screen.y + unit * 0.25, unit * 0.07);
    add(ox + body.w - 1, screen.y + unit * 0.2, unit * 0.11);
  }

  if (['tablet', 'laptop', 'imac', 'tv'].includes(m.kind)) {
    // Camera dot centred on the top bezel.
    parts.push(
      `<circle cx="${round(cx)}" cy="${round(m.top / 2)}" r="${Math.max(1.5, Math.round(m.top * 0.16))}" fill="${BODY_EDGE}"/>`,
    );
  }

  // Extra furniture below the body: laptop base, monitor stand, TV feet.
  let extraHeight = 0;
  if (m.kind === 'laptop') {
    const baseH = Math.max(10, Math.round(device.width * 0.014));
    const lipW = Math.round(body.w * 0.16);
    extraHeight = baseH;
    parts.push(
      `<path fill="${METAL}" d="M${round(ox - pad.left)},${round(body.h)} ` +
        `H${round(ox + body.w + pad.right)} ` +
        `l${round(-pad.right * 0.6)},${round(baseH)} ` +
        `H${round(ox - pad.left * 0.4)} Z"/>`,
      `<rect x="${round(cx - lipW / 2)}" y="${round(body.h + baseH * 0.15)}" width="${lipW}" height="${round(baseH * 0.3)}" rx="${round(baseH * 0.15)}" fill="${BODY_LIGHT}"/>`,
    );
  } else if (m.kind === 'imac') {
    const neckH = Math.round(device.height * 0.12);
    const neckW = Math.round(body.w * 0.16);
    const footW = Math.round(body.w * 0.34);
    const footH = Math.max(6, Math.round(neckH * 0.16));
    extraHeight = neckH + footH;
    parts.push(
      `<rect x="${round(cx - neckW / 2)}" y="${round(body.h)}" width="${neckW}" height="${neckH}" fill="${METAL}"/>`,
      `<rect x="${round(cx - footW / 2)}" y="${round(body.h + neckH)}" width="${footW}" height="${footH}" rx="${round(footH / 2)}" fill="${METAL}"/>`,
    );
  } else if (m.kind === 'tv') {
    const neckH = Math.round(device.height * 0.06);
    const footW = Math.round(body.w * 0.28);
    const footH = Math.max(5, Math.round(neckH * 0.22));
    extraHeight = neckH + footH;
    parts.push(
      `<path fill="${BODY_LIGHT}" d="M${round(cx - footW * 0.12)},${round(body.h)} h${round(footW * 0.24)} l${round(footW * 0.1)},${neckH} h${round(-footW * 0.44)} Z"/>`,
      `<rect x="${round(cx - footW / 2)}" y="${round(body.h + neckH)}" width="${footW}" height="${footH}" rx="${round(footH / 2)}" fill="${BODY_LIGHT}"/>`,
    );
  }

  const frame = { w: body.w + pad.left + pad.right, h: body.h + extraHeight };
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.w}" height="${frame.h}" ` +
    `viewBox="0 0 ${frame.w} ${frame.h}">${parts.join('')}</svg>\n`;

  return { svg, frame, screen };
}

/*
 * Generate only when run directly: the unit tests import topFurniture() to
 * assert the camera fits inside the status bar, and importing must not rewrite
 * every frame as a side effect.
 */
const runDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!runDirectly) {
  // Nothing to do; the exports above are the API.
} else {
fs.mkdirSync(OUT_DIR, { recursive: true });
const geometry = {};

for (const device of DEVICES) {
  const { svg, frame, screen } = draw(device);
  fs.writeFileSync(path.join(OUT_DIR, `${device.id}.svg`), svg, 'utf8');
  geometry[device.id] = {
    frame: { w: frame.w, h: frame.h },
    screen: {
      leftPct: round((screen.x / frame.w) * 100),
      topPct: round((screen.y / frame.h) * 100),
      widthPct: round((screen.w / frame.w) * 100),
      heightPct: round((screen.h / frame.h) * 100),
      radiusPct: round((screen.r / screen.w) * 100),
    },
  };
}

fs.writeFileSync(
  path.join(ROOT, 'src', 'data', 'frame-geometry.js'),
  '// Generated by tools/build-frames.mjs - do not edit by hand.\n' +
    '// Screen cutout of each generated frame, as a percentage of the frame box.\n' +
    `export const FRAME_GEOMETRY = ${JSON.stringify(geometry, null, 2)};\n`,
  'utf8',
);

const bytes = fs
  .readdirSync(OUT_DIR)
  .reduce((sum, f) => sum + fs.statSync(path.join(OUT_DIR, f)).size, 0);
console.log(
  `drew ${DEVICES.length} frames (${(bytes / 1024).toFixed(0)} KB total) and frame-geometry.js`,
);
}
