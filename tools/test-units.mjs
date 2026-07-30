/**
 * Unit tests for the pure logic: which device UI each device gets, and how user
 * agents are derived per browser. These classifications come from aspect-ratio
 * heuristics, so a table test is the only thing that keeps a new device from
 * being silently misclassified.
 *
 * Run: node tools/test-units.mjs
 */

import { DEVICES, DEVICE_BY_ID } from '../src/data/devices.js';
import { FRAME_GEOMETRY } from '../src/data/frame-geometry.js';
import { chromeFor, isRotatable } from '../src/lib/device-chrome.js';
import { computeGeometry, fitZoom, capturedPerPagePx } from '../src/viewer/geometry.js';
import { fileStem } from '../src/viewer/capture.js';
import { sampleWidths, toMarkdown } from '../src/viewer/audit-ui.js';
import { topFurniture } from './build-frames.mjs';
import {
  parseLength,
  extractWidths,
  parseBreakpoints,
  activeRange,
  describeRange,
} from '../src/lib/breakpoints.js';
import {
  platformOf,
  browsersFor,
  defaultBrowserFor,
  uaFor,
  isChromium,
} from '../src/data/browsers.js';
import { menuDeviceIds, targetUrlOf, MAX_MENU_DEVICES } from '../src/lib/menu.js';

let failures = 0;
const ok = (name, pass, detail = '') => {
  if (!pass) {
    failures++;
    console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`);
  }
};

const kinds = (device, rotated = false) => {
  const ui = chromeFor(device, rotated);
  return [ui.top?.kind ?? null, ui.bottom?.kind ?? null];
};

// --- device UI classification ------------------------------------------------
const EXPECTED = {
  'iphone-15-pro': ['ios-status', 'ios-home'],
  'iphone-16-pro-max': ['ios-status', 'ios-home'],
  // Home-button era: a short status bar and no home indicator.
  'iphone-se': ['ios-status', null],
  'iphone-5': ['ios-status', null],
  'galaxy-s24': ['android-status', 'android-nav'],
  'pixel-8': ['android-status', 'android-nav'],
  'surface-duo': ['android-status', 'android-nav'],
  // 4:3 artwork, so treated as the home-button generation.
  'ipad-mini': ['ios-status', null],
  'ipad-air-4': ['ios-status', 'ios-home'],
  'ipad-pro-11': ['ios-status', 'ios-home'],
  'galaxy-tab-s7': ['android-status', 'android-nav'],
  'macbook-air-13': ['browser', null],
  'macbook-pro-16': ['browser', null],
  'dell-latitude-14': ['browser', null],
  'imac-24': ['browser', null],
  // A television gets no simulated furniture at all.
  'samsung-tv-55': [null, null],
};

for (const [id, expected] of Object.entries(EXPECTED)) {
  const device = DEVICE_BY_ID.get(id);
  ok(`device exists: ${id}`, !!device);
  if (!device) continue;
  const actual = kinds(device);
  ok(
    `device UI for ${id}`,
    actual[0] === expected[0] && actual[1] === expected[1],
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

// Every device must classify without throwing, and heights must be sane.
for (const device of DEVICES) {
  for (const rotated of [false, true]) {
    const ui = chromeFor(device, rotated);
    const top = ui.top?.height ?? 0;
    const bottom = ui.bottom?.height ?? 0;
    ok(
      `${device.id} UI fits inside the screen`,
      top + bottom < Math.min(device.width, device.height),
      `${top}+${bottom} vs ${Math.min(device.width, device.height)}`,
    );
    ok(`${device.id} heights are positive`, top >= 0 && bottom >= 0);
  }
}

// Landscape on an iPhone hides the status bar; Android keeps both bars.
ok(
  'iOS landscape hides the status bar',
  kinds(DEVICE_BY_ID.get('iphone-15-pro'), true)[0] === null,
);
ok(
  'iOS landscape keeps the home indicator',
  kinds(DEVICE_BY_ID.get('iphone-15-pro'), true)[1] === 'ios-home',
);
ok(
  'Android landscape keeps the status bar',
  kinds(DEVICE_BY_ID.get('galaxy-s24'), true)[0] === 'android-status',
);

// --- rotation ----------------------------------------------------------------
for (const device of DEVICES) {
  const expected = device.category === 'phone' || device.category === 'tablet';
  ok(`rotatable: ${device.id}`, isRotatable(device) === expected, device.category);
}

// --- platforms and browsers --------------------------------------------------
const EXPECTED_PLATFORM = {
  'iphone-15-pro': 'ios',
  'ipad-air-4': 'ipados',
  'galaxy-s24': 'android',
  'macbook-air-13': 'macos',
  'dell-latitude-14': 'windows',
  'samsung-tv-55': 'tizen',
};
for (const [id, expected] of Object.entries(EXPECTED_PLATFORM)) {
  ok(
    `platform of ${id}`,
    platformOf(DEVICE_BY_ID.get(id)) === expected,
    platformOf(DEVICE_BY_ID.get(id)),
  );
}

for (const device of DEVICES) {
  const list = browsersFor(device);
  ok(`${device.id} offers at least one browser`, list.length >= 1);

  // The default browser must reproduce the catalogue's own user agent.
  const fallback = defaultBrowserFor(device);
  ok(
    `${device.id} default UA is unchanged`,
    uaFor(device, fallback) === device.ua,
    uaFor(device, fallback),
  );

  for (const browser of list) {
    const ua = uaFor(device, browser.id);
    ok(
      `${device.id}/${browser.id} produces a UA`,
      typeof ua === 'string' && ua.length > 20,
    );
    ok(
      `${device.id}/${browser.id} UA has no leftover token`,
      !/undefined|NaN/.test(ua),
      ua,
    );
  }
}

// Spot-check the per-browser tokens sites actually sniff for.
const iphone = DEVICE_BY_ID.get('iphone-15-pro');
ok(
  'iOS Chrome uses CriOS',
  /CriOS\//.test(uaFor(iphone, 'chrome')),
  uaFor(iphone, 'chrome'),
);
ok(
  'iOS Firefox uses FxiOS',
  /FxiOS\//.test(uaFor(iphone, 'firefox')),
  uaFor(iphone, 'firefox'),
);
ok(
  'iOS Edge uses EdgiOS',
  /EdgiOS\//.test(uaFor(iphone, 'edge')),
  uaFor(iphone, 'edge'),
);
ok(
  'iOS Chrome drops the Safari Version token',
  !/Version\//.test(uaFor(iphone, 'chrome')),
);
ok('iOS browsers are not treated as Chromium', !isChromium(iphone, 'chrome'));

const galaxy = DEVICE_BY_ID.get('galaxy-s24');
ok(
  'Samsung Internet UA keeps the model',
  /SamsungBrowser\/[\d.]+/.test(uaFor(galaxy, 'samsung')) &&
    /SM-S921B/.test(uaFor(galaxy, 'samsung')),
  uaFor(galaxy, 'samsung'),
);
ok(
  'Android Firefox is Gecko',
  /Gecko\/.*Firefox/.test(uaFor(galaxy, 'firefox')),
  uaFor(galaxy, 'firefox'),
);
ok('Android Chrome is Chromium', isChromium(galaxy, 'chrome'));

const mac = DEVICE_BY_ID.get('macbook-air-13');
ok(
  'macOS Safari UA',
  /Version\/[\d.]+ Safari/.test(uaFor(mac, 'safari')),
  uaFor(mac, 'safari'),
);
ok(
  'macOS Edge appends Edg/',
  /Edg\/[\d.]+$/.test(uaFor(mac, 'edge')),
  uaFor(mac, 'edge'),
);

// --- breakpoint parsing ------------------------------------------------------
ok('px length', parseLength('768px') === 768);
ok('bare number', parseLength('768') === 768);
ok('em converts at 16px', parseLength('48em') === 768);
ok('rem converts at 16px', parseLength('30rem') === 480);
ok('pt converts', Math.round(parseLength('72pt')) === 96);
ok('fractional px', parseLength('767.98px') === 767.98);
ok('rejects nonsense', parseLength('auto') === null);
ok('rejects viewport units', parseLength('50vw') === null);

const widths = (text) =>
  extractWidths(text).map((w) => `${w.type}:${Math.round(w.px)}`);
ok(
  'min-width',
  widths('(min-width: 768px)').join() === 'min:768',
  widths('(min-width: 768px)').join(),
);
ok(
  'max-width',
  widths('(max-width: 767px)').join() === 'max:767',
  widths('(max-width: 767px)').join(),
);
ok(
  'and-joined pair',
  widths('screen and (min-width: 768px) and (max-width: 1023px)').join() ===
    'min:768,max:1023',
  widths('screen and (min-width: 768px) and (max-width: 1023px)').join(),
);
ok(
  'range syntax >=',
  widths('(width >= 768px)').join() === 'min:768',
  widths('(width >= 768px)').join(),
);
ok(
  'range syntax <',
  widths('(width < 1024px)').join() === 'max:1024',
  widths('(width < 1024px)').join(),
);
ok(
  'reversed operand order',
  extractWidths('(768px <= width)').some((w) => w.type === 'min' && w.px === 768),
  JSON.stringify(extractWidths('(768px <= width)')),
);
ok(
  'interval form yields both bounds',
  (() => {
    const found = extractWidths('(768px <= width < 1024px)');
    return (
      found.some((w) => w.type === 'min' && w.px === 768) &&
      found.some((w) => w.type === 'max' && w.px === 1024)
    );
  })(),
  JSON.stringify(extractWidths('(768px <= width < 1024px)')),
);
ok('ignores height queries', extractWidths('(min-height: 600px)').length === 0);
ok('ignores orientation', extractWidths('(orientation: landscape)').length === 0);

// max-width boundaries are reported as the width where the layout flips, so the
// two common spellings of one breakpoint collapse instead of doubling up.
const bp = parseBreakpoints([
  '(min-width: 768px)',
  '(max-width: 767px)',
  'print',
  '(min-width: 48em)',
  '(min-width: 1024px)',
]);
ok('breakpoints dedupe across spellings', bp.join() === '768,1024', bp.join());
ok(
  'breakpoints are sorted',
  parseBreakpoints(['(min-width: 900px)', '(min-width: 300px)']).join() === '300,900',
);
ok('no breakpoints from an empty list', parseBreakpoints([]).length === 0);
ok('tolerates undefined', parseBreakpoints(undefined).length === 0);

const range = activeRange([480, 768, 1024], 800);
ok(
  'active range picks the band',
  range.from === 768 && range.to === 1024,
  JSON.stringify(range),
);
ok(
  'below the first breakpoint',
  JSON.stringify(activeRange([480, 768], 320)) === '{"from":0,"to":480}',
);
ok('above the last breakpoint', activeRange([480, 768], 1600).to === null);
ok(
  'range description',
  describeRange({ from: 768, to: 1024 }) === '768-1023px',
  describeRange({ from: 768, to: 1024 }),
);
ok(
  'open-ended description',
  describeRange({ from: 1024, to: null }) === '1024px and up',
);
ok('lowest band description', describeRange({ from: 0, to: 480 }) === 'up to 479px');

// --- viewer geometry ---------------------------------------------------------
const macbook = DEVICE_BY_ID.get('macbook-air-13');
const geoOf = (device, state = {}) =>
  computeGeometry(device, FRAME_GEOMETRY[device.id], {
    index: 0,
    rotated: false,
    showFrame: true,
    showDeviceUi: true,
    customSize: null,
    ...state,
  });

{
  const g = geoOf(iphone);
  ok(
    'cutout is exactly the device viewport',
    g.screen.w === 393 && g.screen.h === 852,
    `${g.screen.w}x${g.screen.h}`,
  );
  ok(
    'page inset by the device UI',
    g.page.w === 393 && g.page.h === 764,
    `${g.page.w}x${g.page.h}`,
  );
  // The bezel must extend past the screen on all sides, or the art is misplaced.
  ok(
    'frame is larger than its cutout',
    g.box.w > g.screen.w && g.box.h > g.screen.h,
    `${g.box.w}x${g.box.h}`,
  );
  ok(
    'cutout sits inside the frame',
    g.screen.x > 0 &&
      g.screen.y > 0 &&
      g.screen.x + g.screen.w < g.box.w + 1 &&
      g.screen.y + g.screen.h < g.box.h + 1,
    JSON.stringify(g.screen),
  );
  // A square iframe filling the cutout box would otherwise poke out past the
  // device silhouette - the bug this radius exists to prevent.
  ok('rounded cutout gets a clip radius', g.radius > 40, String(g.radius));
}

{
  const g = geoOf(iphone, { rotated: true });
  ok(
    'rotation swaps the viewport',
    g.screen.w === 852 && g.screen.h === 393,
    `${g.screen.w}x${g.screen.h}`,
  );
  ok('rotation swaps the frame box', g.box.w > g.box.h, `${g.box.w}x${g.box.h}`);
  ok('rotated art is flagged for turning', g.art?.rotate === true);
  ok(
    'landscape drops the status bar, keeps the indicator',
    g.ui.top === null && g.ui.bottom?.kind === 'ios-home',
  );
  ok(
    'rotated cutout stays inside the frame',
    g.screen.x >= 0 && g.screen.x + g.screen.w <= g.box.w + 1,
    JSON.stringify(g.screen),
  );
  ok(
    'radius is orientation-independent',
    Math.abs(g.radius - geoOf(iphone).radius) < 0.001,
  );
}

{
  const g = geoOf(macbook);
  // A laptop screen is very nearly square-cornered - a few pixels, against the
  // ~58px of a phone. What matters is that it is not phone-like.
  ok('laptop screen is near square-cornered', g.radius < 6, String(g.radius));
  ok(
    'a phone is far more rounded than a laptop',
    geoOf(iphone).radius > g.radius * 8,
    `${geoOf(iphone).radius} vs ${g.radius}`,
  );
  ok('laptop page sits under a browser bar', g.page.h === 754, String(g.page.h));
  ok('laptop ignores rotation', geoOf(macbook, { rotated: true }).screen.w === 1280);
}

{
  const bare = geoOf(iphone, { showFrame: false });
  ok('frame off means no art', bare.art === null);
  ok('frame off means no clip radius', bare.radius === 0);
  ok('frame off makes the box the viewport', bare.box.w === 393 && bare.box.h === 852);
  ok('frame off keeps the device UI inset', bare.page.h === 764, String(bare.page.h));

  const naked = geoOf(iphone, { showFrame: false, showDeviceUi: false });
  ok(
    'UI off gives the whole screen to the page',
    naked.page.h === 852,
    String(naked.page.h),
  );
}

{
  const custom = geoOf(iphone, { customSize: { w: 900, h: 700 } });
  ok(
    'custom size drives the viewport',
    custom.screen.w === 900 && custom.screen.h === 700,
    `${custom.screen.w}x${custom.screen.h}`,
  );
  ok('custom size renders bare', custom.art === null && custom.radius === 0);
  ok(
    'custom size still insets the device UI',
    custom.page.h === 612,
    String(custom.page.h),
  );
  // The size belongs to the leading pane only; the others keep their devices.
  const trailing = computeGeometry(iphone, FRAME_GEOMETRY[iphone.id], {
    index: 1,
    rotated: false,
    showFrame: true,
    showDeviceUi: true,
    customSize: { w: 900, h: 700 },
  });
  ok(
    'custom size does not leak to other panes',
    trailing.screen.w === 393,
    String(trailing.screen.w),
  );
  ok(
    'custom size allows rotating a non-rotatable device',
    geoOf(macbook, { customSize: { w: 900, h: 700 }, rotated: true }).screen.w === 700,
  );
}

ok(
  'fit zoom never exceeds 1',
  fitZoom([{ w: 100, h: 100 }], { w: 9999, h: 9999 }) === 1,
);
ok(
  'fit zoom shrinks to the narrower axis',
  fitZoom([{ w: 1000, h: 500 }], { w: 500, h: 500 }) === 0.5,
  String(fitZoom([{ w: 1000, h: 500 }], { w: 500, h: 500 })),
);
ok(
  'fit zoom accounts for every pane',
  fitZoom(
    [
      { w: 500, h: 100 },
      { w: 500, h: 100 },
    ],
    { w: 500, h: 500 },
  ) === 0.5,
);
ok('fit zoom copes with no panes', fitZoom([], { w: 100, h: 100 }) === 1);

// Forgetting the zoom term here once left gaps between stitched slices.
ok(
  'captured pixels per page pixel folds in the zoom',
  capturedPerPagePx(2, 0.5) === 1 && capturedPerPagePx(1, 1) === 1,
);

// --- the camera must fit inside the status bar --------------------------------
/*
 * The frame draws a notch or punch-hole over the top of the screen; the device
 * UI reserves a status bar for it. If the camera is taller than the bar it hangs
 * into the page, which is exactly what happened when every Android phone was
 * given a 32px Apple-style pill above a 24px bar.
 */
for (const device of DEVICES) {
  const camera = topFurniture(device);
  if (!camera) continue;
  const bar = chromeFor(device, false).top?.height ?? 0;
  ok(
    `${device.id}: camera fits inside the status bar`,
    camera.y >= 0 && camera.y + camera.h <= bar,
    `camera ${camera.y}..${camera.y + camera.h} vs bar 0..${bar}`,
  );
  ok(
    `${device.id}: camera is not a sliver`,
    camera.h >= 6 && camera.w >= 6,
    `${camera.w}x${camera.h}`,
  );
}

ok(
  'an iPhone gets a wide pill',
  topFurniture(DEVICE_BY_ID.get('iphone-15-pro'))?.kind === 'pill',
  topFurniture(DEVICE_BY_ID.get('iphone-15-pro'))?.kind,
);
ok(
  'an Android phone gets a round punch-hole, not a pill',
  (() => {
    const c = topFurniture(DEVICE_BY_ID.get('galaxy-s24'));
    return c?.kind === 'hole' && c.w === c.h;
  })(),
  JSON.stringify(topFurniture(DEVICE_BY_ID.get('galaxy-s24'))),
);
ok(
  'a home-button iPhone has no camera cluster over the screen',
  topFurniture(DEVICE_BY_ID.get('iphone-se')) === null,
);
ok('a laptop has no camera cluster over the screen', topFurniture(macbook) === null);

// --- capture file naming -----------------------------------------------------
const dev = (id) => ({ id });
ok(
  'capture name is prefixed with the host',
  fileStem('https://www.github.com/foo', [dev('iphone-15-pro')], 'portrait') ===
    'github.com-iphone-15-pro-portrait',
  fileStem('https://www.github.com/foo', [dev('iphone-15-pro')], 'portrait'),
);
ok(
  'compared devices all appear in the name',
  fileStem('https://a.example.com', [dev('a'), dev('b')], 'audit') ===
    'a.example.com-a+b-audit',
  fileStem('https://a.example.com', [dev('a'), dev('b')], 'audit'),
);
ok('no URL still yields a usable name', fileStem('', [dev('x')], 'y') === 'page-x-y');

// --- audit sweep sampling ----------------------------------------------------
const wide = Array.from({ length: 48 }, (_, i) => 300 + i * 10);
ok(
  'a short breakpoint list is swept whole',
  sampleWidths([320, 768, 1024]).length === 3,
);
ok('a long list is sampled down', sampleWidths(wide, 12).length <= 12);
{
  const picked = sampleWidths(wide, 12);
  // The extremes matter most: the narrowest and widest are where things break.
  ok(
    'sampling keeps both ends',
    picked[0] === 300 && picked.at(-1) === 770,
    picked.join(),
  );
  ok(
    'sampling stays in ascending order',
    picked.every((v, i) => i === 0 || v > picked[i - 1]),
    picked.join(),
  );
}

// --- audit report ------------------------------------------------------------
{
  const md = toMarkdown({
    url: 'https://example.com',
    device: 'Apple iPhone 15 Pro',
    panes: [
      {
        label: 'Apple iPhone 15 Pro',
        result: {
          viewportWidth: 393,
          groups: [
            {
              title: 'Horizontal overflow',
              items: [{ label: 'div#hero', detail: '900px wide' }],
            },
          ],
        },
      },
    ],
    sweep: [
      {
        width: 320,
        total: 2,
        groups: [{ title: 'Horizontal overflow', items: [1, 2] }],
      },
      { width: 768, total: 0, groups: [] },
    ],
  });
  ok('report names the page', md.includes('https://example.com'));
  ok(
    'report has a sweep table',
    md.includes('| 320px | 2 |') && md.includes('| 768px | 0 | clean |'),
    md.slice(0, 140),
  );
  ok('report lists findings', md.includes('`div#hero` - 900px wide'));
  ok(
    'report marks a clean pane',
    toMarkdown({
      url: 'u',
      device: 'd',
      panes: [{ label: 'X', result: { viewportWidth: 1, groups: [] } }],
    }).includes('No issues found.'),
  );
}

// --- right-click menu --------------------------------------------------------
{
  const ids = (state) => menuDeviceIds(state);

  ok(
    'menu falls back to starters when nothing is stored',
    ids({}).length > 0 && ids({}).every((id) => DEVICE_BY_ID.has(id)),
    ids({}).join(', '),
  );
  ok(
    'menu leads with the last used device',
    ids({ lastDeviceId: 'galaxy-s24', favourites: ['iphone-15-pro'] })[0] ===
      'galaxy-s24',
  );
  ok(
    'menu lists each device once',
    ids({
      lastDeviceId: 'iphone-15-pro',
      favourites: ['iphone-15-pro', 'ipad-mini'],
      recents: ['iphone-15-pro'],
    }).join(',') === 'iphone-15-pro,ipad-mini',
  );
  ok(
    'menu drops devices that no longer exist',
    !ids({ favourites: ['nokia-3310'], recents: ['ipad-mini'] }).includes('nokia-3310'),
  );
  ok(
    'menu is capped',
    ids({ recents: DEVICES.map((d) => d.id) }).length === MAX_MENU_DEVICES,
  );

  const VIEWER = 'chrome-extension://abc/src/viewer/viewer.html';
  const target = (info) => targetUrlOf(info, VIEWER);

  ok(
    'a link beats the page it sits on',
    target({ linkUrl: 'https://a.test/x', pageUrl: 'https://b.test/' }) ===
      'https://a.test/x',
  );
  ok(
    'a plain page is the target',
    target({ pageUrl: 'https://b.test/' }) === 'https://b.test/',
  );
  ok(
    'an iframe on a normal site does not hijack the target',
    target({ pageUrl: 'https://b.test/', frameUrl: 'https://ads.test/' }) ===
      'https://b.test/',
  );
  ok(
    'inside a viewer, the framed site is the target',
    target({
      pageUrl: `${VIEWER}?devices=iphone-15-pro&url=https%3A%2F%2Fc.test%2F`,
      frameUrl: 'https://c.test/deep',
    }) === 'https://c.test/deep',
  );
  ok(
    "a click on the viewer's own furniture falls back to what it is showing",
    target({
      pageUrl: `${VIEWER}?devices=iphone-15-pro&url=https%3A%2F%2Fc.test%2F`,
    }) === 'https://c.test/',
  );
  ok(
    'an empty viewer resolves to nothing rather than its own address',
    target({ pageUrl: `${VIEWER}?devices=iphone-15-pro` }) === '',
  );
  for (const unframable of [
    'chrome://settings',
    'about:blank',
    'file:///c:/x.html',
    '',
  ])
    ok(
      `${unframable || '(blank)'} is not a target`,
      target({ pageUrl: unframable }) === '',
    );
  ok(
    'a javascript: link is not a target',
    target({ linkUrl: 'javascript:alert(1)', pageUrl: 'https://b.test/' }) === '',
  );
}

console.log(
  failures === 0 ? 'all unit tests passed' : `\n${failures} unit test failure(s)`,
);
process.exit(failures ? 1 : 0);
