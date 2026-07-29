/**
 * End-to-end smoke test: loads the unpacked extension into real Chrome and
 * exercises the viewer against live sites.
 *
 * Run: node tools/smoke.mjs
 */

import puppeteer from 'puppeteer-core';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'tools', 'shots');

/**
 * Stable Chrome dropped the --load-extension switch, so tests run against
 * Chrome for Testing (install with:
 *   npx @puppeteer/browsers install chrome@stable --path tools/browsers).
 */
function findChrome() {
  const base = path.join(ROOT, 'tools', 'browsers', 'chrome');
  if (fs.existsSync(base)) {
    for (const dir of fs.readdirSync(base)) {
      const exe = path.join(base, dir, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  throw new Error('Chrome for Testing not found under tools/browsers');
}

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Dispatch a click from inside the page.
 *
 * puppeteer's own click() first waits for the element to be visible and stable,
 * and that check intermittently stalls on this toolbar - verified separately
 * that the button and the page are perfectly responsive, so the wait is the
 * fragile part, not the extension. Real trusted input is still exercised by the
 * touch-synthesis test, which drives viewer.mouse.
 */
const clickIn = (page, selector) => page.$eval(selector, (node) => node.click());

/** Poll until `read()` satisfies `done`, or give up. */
async function until(read, done, timeoutMs = 90000, stepMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await wait(stepMs);
    value = await read();
  }
  return value;
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gonbi-'));
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: false,
  userDataDir,
  // Screenshotting a heavy framed site (GitHub) can outrun the 30s default.
  protocolTimeout: 180000,
  args: [
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`,
    '--no-first-run',
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--no-default-browser-check',
    '--window-size=1500,1000',
    // Recording falls back to getDisplayMedia, whose picker cannot be driven
    // from CDP; these accept the current tab automatically.
    '--auto-accept-this-tab-capture',
    '--auto-grant-captured-surface-control-prompt',
  ],
});

try {
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
    { timeout: 20000 },
  );
  const extId = new URL(swTarget.url()).host;
  check('extension loads and service worker starts', !!extId, extId);

  // ---------------------------------------------------------------- popup --
  const popup = await browser.newPage();
  await popup.setViewport({ width: 372, height: 560 });
  await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`, {
    waitUntil: 'networkidle0',
  });
  await wait(600);

  const rowCount = await popup.$$eval('.row', (rows) => rows.length);
  check('popup lists devices', rowCount >= 61, `${rowCount} rows`);

  const popupIcons = await popup.evaluate(() => ({
    brand: !!document.querySelector('.bar__icon svg path'),
    stars: document.querySelectorAll('.row__star svg path').length,
  }));
  check(
    'popup icons rendered',
    popupIcons.brand && popupIcons.stars >= 61,
    `brand ${popupIcons.brand}, ${popupIcons.stars} stars`,
  );

  const a11y = await popup.evaluate(() => {
    const row = document.querySelector('.row');
    return {
      listRole: document.getElementById('list').getAttribute('role'),
      rowRole: row?.getAttribute('role'),
      tabbable: row?.tabIndex === 0,
      combobox: document.getElementById('search').getAttribute('role'),
      active: document.getElementById('search').getAttribute('aria-activedescendant'),
    };
  });
  check(
    'popup uses an accessible listbox',
    a11y.listRole === 'listbox' &&
      a11y.rowRole === 'option' &&
      a11y.tabbable &&
      a11y.combobox === 'combobox' &&
      !!a11y.active,
    JSON.stringify(a11y),
  );

  await popup.type('#search', 'ip15p');
  await wait(250);
  const firstHit = await popup.$eval('.row .row__name', (n) => n.textContent.trim());
  check('fuzzy search "ip15p"', /iPhone 15 Pro/.test(firstHit), firstHit);
  await popup.screenshot({ path: path.join(SHOTS, 'popup.png') });

  /*
   * The popup to viewer hand-off, which nothing covered: every other viewer
   * check navigates straight to viewer.html and so never exercised the message,
   * the tab creation or the arming a real click goes through.
   *
   * Runs last in this block, because opening a device makes the popup close
   * itself - which also means the tab count nets out and cannot be asserted on.
   */
  const viewerTabs = async () =>
    (await browser.pages()).filter((p) => p.url().includes('/src/viewer/viewer.html'));
  check('no viewer tab open yet', (await viewerTabs()).length === 0);

  // The search above is still filtering the list; clear it to see every device.
  await popup.evaluate(() => {
    const search = document.getElementById('search');
    search.value = '';
    search.dispatchEvent(new Event('input'));
  });
  await wait(400);
  await popup.$eval('.row[data-id="galaxy-s24"]', (row) => row.click());
  await wait(3500);
  const [opened] = await viewerTabs();
  check(
    'clicking a device row opens a viewer tab on that device',
    !!opened && /devices?=galaxy-s24/.test(opened.url()),
    opened ? new URL(opened.url()).search : '(no viewer tab)',
  );
  if (opened) await opened.close();

  // openViewer must also honour a supplied URL, which the row click cannot show:
  // the popup's "active tab" in a test is the popup itself.
  const popupAgain = await browser.newPage();
  await popupAgain.goto(`chrome-extension://${extId}/src/popup/popup.html`, {
    waitUntil: 'networkidle0',
  });
  await popupAgain.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'openViewer',
      deviceId: 'pixel-8',
      url: 'https://example.com/',
    }),
  );
  await wait(3500);
  const [withUrl] = await viewerTabs();
  check(
    'openViewer carries the target URL through',
    !!withUrl && /url=https%3A%2F%2Fexample.com/.test(withUrl.url()),
    withUrl ? new URL(withUrl.url()).search.slice(0, 70) : '(no viewer tab)',
  );
  if (withUrl) await withUrl.close();
  await popupAgain.close();

  // --------------------------------------------------------------- viewer --
  const viewer = await browser.newPage();
  await viewer.setViewport({ width: 1440, height: 900 });

  // Screenshots and recordings are saved with an <a download>; give Chrome a
  // destination so nothing blocks on a save prompt.
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'gonbi-dl-'));
  const cdp = await viewer.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloads,
    eventsEnabled: false,
  });
  const open = async (query) => {
    await viewer.goto(`chrome-extension://${extId}/src/viewer/viewer.html?${query}`, {
      waitUntil: 'domcontentloaded',
    });
    await wait(5000);
    return viewer
      .frames()
      .filter((f) => f !== viewer.mainFrame() && f.url().startsWith('http'));
  };
  const site = (url) => `url=${encodeURIComponent(url)}`;

  let frames = await open(`device=iphone-15-pro&${site('https://example.com')}`);
  check('iframe navigated', frames.length === 1, frames[0]?.url());

  const toolbarIcons = await viewer.$$eval('.btn[data-icon] svg path', (p) => p.length);
  check('viewer toolbar icons rendered', toolbarIcons >= 10, `${toolbarIcons} paths`);

  if (frames[0]) {
    const info = await frames[0].evaluate(() => ({
      w: window.innerWidth,
      h: window.innerHeight,
      ua: navigator.userAgent,
      touch: navigator.maxTouchPoints,
      body: document.body?.innerText?.slice(0, 40) ?? '',
    }));
    // Device UI is on by default: 852 screen minus a 54px status bar and a
    // 34px home indicator leaves 764 for the page.
    check(
      'page inset by device UI to 393x764',
      info.w === 393 && info.h === 764,
      `${info.w}x${info.h}`,
    );
    check('user agent spoofed to iPhone', /iPhone/.test(info.ua), info.ua.slice(0, 62));
    check('touch points reported', info.touch === 5, String(info.touch));
    check('page actually rendered', info.body.length > 0, JSON.stringify(info.body));
  }

  const iphoneRadius = await viewer.$eval('.frame__viewport', (s) =>
    parseFloat(getComputedStyle(s).borderTopLeftRadius),
  );
  check('viewport clipped to screen radius', iphoneRadius > 40, `${iphoneRadius}px`);

  const bars = await viewer.evaluate(() => ({
    top: document.querySelector('.frame__chrome--top .bar')?.className ?? null,
    bottom: document.querySelector('.frame__chrome--bottom .bar')?.className ?? null,
    glyphs: document.querySelectorAll('.frame__chrome--top .bar__glyphs svg').length,
  }));
  check(
    'iOS status bar and home indicator drawn',
    /ios-status/.test(bars.top) && /bar--home/.test(bars.bottom) && bars.glyphs === 3,
    `${bars.top} / ${bars.bottom}, ${bars.glyphs} glyphs`,
  );

  const sandbox = await viewer.$eval('.frame__screen', (f) =>
    f.getAttribute('sandbox'),
  );
  check(
    'iframe sandboxed against top navigation',
    !!sandbox && !/allow-top-navigation/.test(sandbox),
    sandbox?.slice(0, 60),
  );

  await viewer.screenshot({ path: path.join(SHOTS, 'viewer-iphone.png') });

  // ------------------------------------------------- navigation tracking --
  // example.com links to iana.org; clicking it must move the address bar.
  await frames[0].evaluate(() => document.querySelector('a')?.click());
  await wait(6000);
  const nav = await viewer.evaluate(() => ({
    url: document.getElementById('url').value,
    back: !document.getElementById('back').disabled,
  }));
  check(
    'address bar follows in-frame navigation',
    !/example\.com\/?$/.test(nav.url) && nav.url.length > 0,
    nav.url,
  );
  check('back button enabled after navigating', nav.back, String(nav.back));

  await clickIn(viewer, '#back');
  await wait(5000);
  const backUrl = await viewer.$eval('#url', (i) => i.value);
  check('back returns to the previous page', /example\.com/.test(backUrl), backUrl);

  // ------------------------------------------------------- touch synthesis --
  frames = await open(`device=iphone-15-pro&${site('https://example.com')}`);
  const box = await viewer.$eval('.frame__screen', (f) => {
    const r = f.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await frames[0].evaluate(() => {
    window.__touches = [];
    for (const type of ['touchstart', 'touchmove', 'touchend']) {
      window.addEventListener(type, () => window.__touches.push(type), true);
    }
  });
  await viewer.mouse.move(box.x, box.y);
  await viewer.mouse.down();
  await viewer.mouse.move(box.x, box.y - 40, { steps: 4 });
  await viewer.mouse.up();
  await wait(400);
  const touches = await frames[0].evaluate(() => window.__touches ?? []);
  check(
    'mouse drag synthesizes touch events',
    touches.includes('touchstart') &&
      touches.includes('touchmove') &&
      touches.includes('touchend'),
    touches.join(','),
  );

  // ---------------------------------------------------------- browser UA --
  frames = await open(
    `device=iphone-15-pro&browser=chrome&${site('https://example.com')}`,
  );
  const criosUa = frames[0] ? await frames[0].evaluate(() => navigator.userAgent) : '';
  check(
    'browser picker switches the UA to iOS Chrome',
    /CriOS\//.test(criosUa),
    criosUa.slice(0, 70),
  );

  // ---------------------------------------------------------- framing etc --
  frames = await open(`device=iphone-15-pro&${site('https://github.com')}`);
  const gh = frames[0]
    ? await frames[0].evaluate(() => ({
        text: document.body?.innerText?.trim().length ?? 0,
        layoutW: document.documentElement.clientWidth,
        scrolls: document.documentElement.scrollHeight > window.innerHeight,
      }))
    : { text: 0, layoutW: 0, scrolls: false };
  check('X-Frame-Options site is framed', gh.text > 50, `${gh.text} chars of text`);
  check(
    'scrollbar does not steal layout width',
    gh.scrolls && gh.layoutW === 393,
    `clientWidth ${gh.layoutW}, scrolls ${gh.scrolls}`,
  );
  await viewer.screenshot({ path: path.join(SHOTS, 'viewer-github.png') });

  // --------------------------------------------------------- failure path --
  await open(`device=iphone-15-pro&${site('https://gonbi-does-not-resolve.invalid')}`);
  await wait(2000);
  const failure = await viewer.evaluate(() => !!document.getElementById('failure'));
  check('unreachable site shows the failure overlay', failure, String(failure));
  await viewer.screenshot({ path: path.join(SHOTS, 'viewer-failure.png') });

  // ---------------------------------------------------------------- laptop --
  frames = await open(`device=macbook-air-13&${site('https://example.com')}`);
  const laptop = frames[0]
    ? await frames[0].evaluate(() => [innerWidth, innerHeight])
    : [];
  check(
    'laptop page is 1280x754 under a 46px browser bar',
    laptop[0] === 1280 && laptop[1] === 754,
    laptop.join('x'),
  );

  const laptopUi = await viewer.evaluate(() => ({
    bar: document.querySelector('.frame__chrome--top .bar')?.className ?? null,
    host: document.querySelector('.bar__omnibox')?.textContent?.trim() ?? '',
    mac: !!document.querySelector('.bar__lights.is-mac'),
    rotateDisabled: document.getElementById('rotate').disabled,
    radius: parseFloat(
      getComputedStyle(document.querySelector('.frame__viewport')).borderTopLeftRadius,
    ),
  }));
  check(
    'laptop gets a browser bar, not a status bar',
    /bar--browser/.test(laptopUi.bar) &&
      laptopUi.mac &&
      laptopUi.host === 'example.com',
    `${laptopUi.bar}, host "${laptopUi.host}"`,
  );
  check(
    'laptop screen is near square-cornered',
    laptopUi.radius < 6,
    `${laptopUi.radius}px`,
  );
  check(
    'rotate disabled for a laptop',
    laptopUi.rotateDisabled === true,
    String(laptopUi.rotateDisabled),
  );
  await viewer.screenshot({ path: path.join(SHOTS, 'viewer-macbook.png') });

  await open(
    `device=macbook-air-13&orientation=rotated&${site('https://example.com')}`,
  );
  const laptopRot = await viewer.$eval('.frame__screen', (s) => [
    parseFloat(s.style.width),
    parseFloat(s.style.height),
  ]);
  check(
    'laptop ignores orientation=rotated',
    laptopRot[0] === 1280 && laptopRot[1] === 754,
    laptopRot.join('x'),
  );

  // ----------------------------------------------------- longest label fit --
  await open(`device=samsung-tv-55&${site('https://example.com')}`);
  const fit = await viewer.evaluate(() => {
    const sel = document.getElementById('device');
    const sizer = document.getElementById('deviceSizer');
    sizer.textContent = sel.selectedOptions[0].textContent;
    return {
      label: sel.selectedOptions[0].textContent,
      selW: sel.getBoundingClientRect().width,
      textW: sizer.getBoundingClientRect().width,
    };
  });
  check(
    'device select fits its longest label',
    fit.selW >= fit.textW + 20,
    `select ${Math.round(fit.selW)}px vs text ${Math.round(fit.textW)}px`,
  );

  // -------------------------------------------------------------- rotation --
  frames = await open(
    `device=iphone-15-pro&orientation=rotated&${site('https://example.com')}`,
  );
  const rot = frames[0]
    ? await frames[0].evaluate(() => [innerWidth, innerHeight])
    : [];
  // Landscape: Safari hides the status bar, the home indicator shrinks to 21px.
  check('rotated page is 852x372', rot[0] === 852 && rot[1] === 372, rot.join('x'));
  await viewer.screenshot({ path: path.join(SHOTS, 'viewer-rotated.png') });

  // ---------------------------------------------------------- multi-device --
  // A light, reliably scrollable page: three simultaneous copies of a heavy
  // site stall the renderer long enough to time out the CDP connection.
  const COMPARE_SITE = 'https://en.wikipedia.org/wiki/Responsive_web_design';
  frames = await open(
    `devices=iphone-15-pro,ipad-air-4,macbook-air-13&${site(COMPARE_SITE)}`,
  );
  const paneCount = await viewer.$$eval('.pane', (p) => p.length);
  check('three devices render side by side', paneCount === 3, `${paneCount} panes`);
  const widths = await Promise.all(
    frames.map((f) => f.evaluate(() => window.innerWidth)),
  );
  check(
    'each pane gets its own viewport width',
    widths.includes(393) && widths.includes(1180) && widths.includes(1280),
    widths.join(', '),
  );

  // Comparison mode: per-pane pickers, an add tile, and no toolbar duplicate.
  const compareUi = await viewer.evaluate(() => ({
    pickers: document.querySelectorAll('.pane__device').length,
    selected: [...document.querySelectorAll('.pane__device')].map((s) => s.value),
    sizes: [...document.querySelectorAll('.pane__size')].map((s) => s.textContent),
    addTile: !!document.querySelector('.addtile__select'),
    toolbarHidden: document.getElementById('device').hidden,
    pressed: document.getElementById('compareToggle').getAttribute('aria-pressed'),
  }));
  check(
    'each pane label is its own device picker',
    compareUi.pickers === 3 &&
      compareUi.selected.join() === 'iphone-15-pro,ipad-air-4,macbook-air-13' &&
      compareUi.sizes.every((s) => /\d+×\d+/.test(s)),
    `${compareUi.pickers} pickers: ${compareUi.selected.join(', ')} / sizes ${compareUi.sizes.join(', ')}`,
  );
  check(
    'add tile shown and toolbar picker stood down',
    compareUi.addTile && compareUi.toolbarHidden && compareUi.pressed === 'true',
    JSON.stringify(compareUi),
  );
  await viewer.screenshot({ path: path.join(SHOTS, 'viewer-compare.png') });

  // Swapping the second pane must leave the others alone.
  await viewer.evaluate(() => {
    const picker = document.querySelectorAll('.pane__device')[1];
    picker.value = 'galaxy-s24';
    picker.dispatchEvent(new Event('change'));
  });
  await wait(6000);
  const afterSwap = await viewer.evaluate(() => ({
    selected: [...document.querySelectorAll('.pane__device')].map((s) => s.value),
  }));
  const swapWidths = await Promise.all(
    viewer
      .frames()
      .filter((f) => f !== viewer.mainFrame() && f.url().startsWith('http'))
      .map((f) => f.evaluate(() => window.innerWidth)),
  );
  // Each pane spoofs its own device even though the header UA is shared.
  const paneUas = await Promise.all(
    viewer
      .frames()
      .filter((f) => f !== viewer.mainFrame() && f.url().startsWith('http'))
      .map((f) =>
        f.evaluate(() => `${window.name}=${navigator.userAgent.slice(0, 40)}`),
      ),
  );
  check(
    'each pane spoofs its own user agent',
    paneUas.some((u) => /gonbi-pane-0=.*iPhone/.test(u)) &&
      paneUas.some((u) => /gonbi-pane-2=.*Macintosh/.test(u)),
    paneUas.join(' | '),
  );

  check(
    'a pane can be swapped in place',
    afterSwap.selected.join() === 'iphone-15-pro,galaxy-s24,macbook-air-13' &&
      swapWidths.includes(360),
    `${afterSwap.selected.join(', ')} widths ${swapWidths.join(', ')}`,
  );

  // The add tile appends a fourth device, then disappears at the cap.
  await viewer.evaluate(() => {
    const select = document.querySelector('.addtile__select');
    select.value = 'pixel-8';
    select.dispatchEvent(new Event('change'));
  });
  await wait(6000);
  const afterAdd = await viewer.evaluate(() => ({
    panes: document.querySelectorAll('.pane').length,
    addTile: !!document.querySelector('.addtile__select'),
  }));
  // The cap is six panes, so a fourth still leaves the tile available.
  check(
    'add tile adds a device',
    afterAdd.panes === 4 && afterAdd.addTile,
    JSON.stringify(afterAdd),
  );

  // A screenshot must frame the devices, not the dashed add tile beside them.
  await viewer.evaluate(() => {
    const picker = document.querySelectorAll('.pane__device')[3];
    picker.closest('.pane').querySelector('.pane__close').click();
  });
  await wait(1500);
  const cropBox = await viewer.evaluate(() => {
    const panes = [...document.querySelectorAll('.pane')].map((p) =>
      p.getBoundingClientRect(),
    );
    const tile = document.querySelector('.addtile')?.getBoundingClientRect() ?? null;
    return {
      panesRight: Math.max(...panes.map((r) => r.right)),
      containerRight: document.getElementById('panes').getBoundingClientRect().right,
      tileRight: tile?.right ?? null,
    };
  });
  check(
    'add tile sits outside the devices bounding box',
    cropBox.tileRight !== null &&
      cropBox.tileRight > cropBox.panesRight &&
      cropBox.containerRight > cropBox.panesRight,
    JSON.stringify(cropBox),
  );

  // Leaving the mode collapses to the leading device.
  await clickIn(viewer, '#compareToggle');
  await wait(1500);
  const afterExit = await viewer.evaluate(() => ({
    panes: document.querySelectorAll('.pane').length,
    heads: getComputedStyle(document.querySelector('.pane__head')).display,
    toolbarHidden: document.getElementById('device').hidden,
    device: document.getElementById('device').value,
  }));
  check(
    'leaving comparison mode collapses to the leading device',
    afterExit.panes === 1 &&
      afterExit.heads === 'none' &&
      !afterExit.toolbarHidden &&
      afterExit.device === 'iphone-15-pro',
    JSON.stringify(afterExit),
  );

  // Back into comparison for the scroll-sync check below.
  frames = await open(
    `devices=iphone-15-pro,ipad-air-4,macbook-air-13&compare=1&${site(COMPARE_SITE)}`,
  );

  // ------------------------------------------------------------ sync scroll --
  // Click via evaluate: the real click path does an intersection check that can
  // queue behind three frames re-loading.
  await clickIn(viewer, '#syncToggle');
  await wait(7000);
  frames = viewer
    .frames()
    .filter((f) => f !== viewer.mainFrame() && f.url().startsWith('http'));
  await frames[0].evaluate(() => window.scrollTo(0, 400));
  await wait(1200);
  const scrolls = await Promise.all(
    frames.map((f) => f.evaluate(() => Math.round(window.scrollY))),
  );
  check(
    'scroll syncs across panes',
    scrolls.length === 3 &&
      scrolls.every((y) => Math.abs(y - scrolls[0]) < 30) &&
      scrolls[0] > 100,
    scrolls.join(', '),
  );

  // -------------------------------------------------------- custom viewport --
  frames = await open(
    `device=iphone-15-pro&w=900&h=700&${site('https://example.com')}`,
  );
  const custom = frames[0]
    ? await frames[0].evaluate(() => [innerWidth, innerHeight])
    : [];
  const customUi = await viewer.evaluate(() => ({
    bare: document.querySelector('.frame').classList.contains('is-bare'),
    art: getComputedStyle(document.querySelector('.frame__art')).display,
    resetShown: !document.getElementById('sizeReset').hidden,
    w: document.getElementById('sizeW').value,
  }));
  // 700 tall minus the 54px status bar and 34px home indicator.
  check(
    'custom size drives the viewport',
    custom[0] === 900 && custom[1] === 612,
    custom.join('x'),
  );
  check(
    'custom size renders bare with a reset affordance',
    customUi.bare &&
      customUi.art === 'none' &&
      customUi.resetShown &&
      customUi.w === '900',
    JSON.stringify(customUi),
  );

  await clickIn(viewer, '#sizeReset');
  await wait(600);
  const afterReset = await viewer.$eval('.frame__screen', (s) =>
    parseFloat(s.style.width),
  );
  check('reset returns to the device size', afterReset === 393, String(afterReset));

  // ----------------------------------------------------------- breakpoints --
  frames = await open(`device=macbook-air-13&${site('https://github.com')}`);
  await wait(4000);
  const bps = await viewer.evaluate(() => ({
    shown: !document.getElementById('breakpoints').hidden,
    chips: [...document.querySelectorAll('#breakpointList .chip')].map((c) =>
      Number(c.textContent),
    ),
    active:
      document.querySelector('#breakpointList .chip.is-active')?.textContent ?? null,
    note: document.getElementById('breakpointNote').textContent,
  }));
  check(
    'page breakpoints extracted from its stylesheets',
    bps.shown && bps.chips.length >= 3 && bps.chips.every((n) => n > 0),
    `${bps.chips.length} chips: ${bps.chips.slice(0, 8).join(', ')}`,
  );
  check(
    'active breakpoint band highlighted',
    !!bps.active,
    `active ${bps.active}, note "${bps.note}"`,
  );

  // Clicking a chip snaps the viewport to that width.
  const target = bps.chips.find((n) => n >= 400 && n <= 1200) ?? bps.chips[0];
  await viewer.evaluate((value) => {
    const chip = [...document.querySelectorAll('#breakpointList .chip')].find(
      (c) => Number(c.textContent) === value,
    );
    chip?.click();
  }, target);
  await wait(800);
  const snapped = await viewer.$eval('.frame__screen', (s) =>
    parseFloat(s.style.width),
  );
  check(
    'breakpoint chip snaps the width',
    snapped === target,
    `${snapped} vs ${target}`,
  );
  await viewer.screenshot({ path: path.join(SHOTS, 'viewer-breakpoints.png') });

  // ------------------------------------------------------------------ audit --
  /*
   * A deliberately broken layout: an element wider than the viewport, a tap
   * target below the accessibility minimum, and unreadable text. It is written
   * into a real page rather than loaded as a data: URL, because data: URLs are
   * not scriptable and so never receive the injected script.
   */
  frames = await open(`device=iphone-15-pro&${site('https://example.com')}`);
  await frames[0].evaluate(() => {
    document.body.innerHTML =
      '<div id="wide" style="width:900px;height:40px;background:#cfc"></div>' +
      '<button id="tiny" style="width:14px;height:14px">x</button>' +
      '<p id="small" style="font-size:8px">unreadable legal text</p>' +
      '<p style="font-size:16px">normal sized copy</p>';
  });
  // Open the panel, then re-check: the automatic audit ran on load, before the
  // markup above existed.
  await clickIn(viewer, '#auditBadge');
  await wait(600);
  // By name, not by position: the panel now ends with Sweep and Export buttons,
  // and .at(-1) silently exported a report instead of re-checking.
  await viewer.evaluate(() => {
    [...document.querySelectorAll('#auditPanel button')]
      .find((b) => b.textContent === 'Re-check')
      ?.click();
  });
  await wait(2500);
  const audit = await viewer.evaluate(() => ({
    badge: document.getElementById('auditBadge').textContent,
    groups: [...document.querySelectorAll('.audit__group h3')].map(
      (h) => h.textContent,
    ),
    labels: [...document.querySelectorAll('.audit__label')].map((l) => l.textContent),
  }));
  check(
    'audit finds the horizontal overflow',
    /Horizontal overflow \(1\)/.test(audit.groups.join(' ')) &&
      audit.labels.some((l) => /div#wide/.test(l)),
    `${audit.badge} - ${audit.groups.join(', ')}`,
  );
  check(
    'audit finds the small tap target and tiny text',
    audit.labels.some((l) => /button#tiny/.test(l)) &&
      audit.labels.some((l) => /p#small/.test(l)),
    audit.labels.slice(0, 4).join(' | '),
  );

  // Hovering a finding must outline it inside the framed page.
  await viewer.evaluate(() => {
    const row = document.querySelector('.audit__group li[data-key]');
    row.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
  });
  await wait(900);
  const ring = await frames[0].evaluate(() => {
    const node = document.getElementById('__gonbi_ring');
    return node ? { w: node.style.width, h: node.style.height } : null;
  });
  check('hovering a finding highlights it in the page', !!ring, JSON.stringify(ring));
  await viewer.screenshot({ path: path.join(SHOTS, 'viewer-audit.png') });

  // The new checks: zoom blocked, missing alt, unlabelled field, low contrast.
  await frames[0].evaluate(() => {
    document.querySelector('meta[name=viewport]')?.remove();
    const meta = document.createElement('meta');
    meta.name = 'viewport';
    meta.content = 'width=device-width, user-scalable=no';
    document.head.append(meta);
    document.body.innerHTML =
      '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="40" height="40">' +
      '<input type="text" id="unlabelled">' +
      '<p style="color:#bbb;background:#fff;font-size:16px">barely readable</p>';
  });
  await viewer.evaluate(() => {
    [...document.querySelectorAll('#auditPanel button')]
      .find((b) => b.textContent === 'Re-check')
      ?.click();
  });
  await wait(2500);
  const extra = await viewer.$$eval('.audit__group h3', (hs) =>
    hs.map((h) => h.textContent),
  );
  check(
    'audit reports zoom, alt, labels and contrast',
    [
      'Zoom restricted',
      'Images without alt',
      'Unlabelled form fields',
      'Low text contrast',
    ].every((title) => extra.some((h) => h.startsWith(title))),
    extra.join(' | '),
  );

  // ------------------------------------------------------------------ sweep --
  frames = await open(`device=iphone-15-pro&${site(COMPARE_SITE)}`);
  await wait(3000);
  await clickIn(viewer, '#auditBadge');
  await wait(600);
  await viewer.evaluate(() => {
    [...document.querySelectorAll('#auditPanel button')]
      .find((b) => /^Sweep/.test(b.textContent))
      ?.click();
  });
  const sweepNote = await until(
    () => viewer.evaluate(() => document.body.dataset.result ?? ''),
    (text) => /widths (have issues|look clean)/.test(text),
    120000,
  );
  const sweepTable = await viewer.evaluate(() => ({
    rows: [...document.querySelectorAll('.audit__table tbody tr')].map(
      (tr) => tr.firstElementChild.textContent,
    ),
    width: parseFloat(document.querySelector('.frame__screen').style.width),
  }));
  check(
    'sweep audits every declared breakpoint',
    sweepTable.rows.length >= 3 && sweepTable.rows.every((r) => /^\d+px$/.test(r)),
    `${sweepNote} - ${sweepTable.rows.join(', ')}`,
  );
  check(
    'sweep restores the original width afterwards',
    sweepTable.width === 393,
    String(sweepTable.width),
  );
  await viewer.screenshot({ path: path.join(SHOTS, 'viewer-sweep.png') });

  // Export the sweep as Markdown.
  await viewer.evaluate(() => {
    [...document.querySelectorAll('#auditPanel button')]
      .find((b) => b.textContent === 'Export report')
      ?.click();
  });
  await until(
    async () =>
      fs
        .readdirSync(downloads)
        .filter((f) => f.startsWith('en.wikipedia.org-') && f.endsWith('.md')),
    (files) => files.length > 0,
    20000,
  );
  const report = fs
    .readdirSync(downloads)
    .find((f) => f.startsWith('en.wikipedia.org-') && f.endsWith('.md'));
  const reportText = report
    ? fs.readFileSync(path.join(downloads, report), 'utf8')
    : '';
  check(
    'report exports as Markdown with the sweep table',
    !!report &&
      report.startsWith('en.wikipedia.org-') &&
      /## Across declared breakpoints/.test(reportText) &&
      /\|\s*\d+px\s*\|/.test(reportText),
    `${report} (${reportText.length} chars)`,
  );

  // ------------------------------------------------------------------- help --
  await viewer.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true })),
  );
  await wait(500);
  const help = await viewer.evaluate(() => ({
    open: !document.getElementById('helpPanel').hidden,
    keys: [...document.querySelectorAll('#helpPanel dt')].map((d) => d.textContent),
  }));
  check(
    'the ? overlay lists every shortcut',
    help.open && help.keys.length >= 15 && help.keys.includes('Shift+S'),
    `${help.keys.length} keys: ${help.keys.slice(0, 6).join(' ')}`,
  );
  await viewer.evaluate(() =>
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    ),
  );
  await wait(300);
  check(
    'Escape closes the panels',
    await viewer.evaluate(() => document.getElementById('helpPanel').hidden),
  );

  // ------------------------------------------------------------ page errors --
  frames = await open(`device=iphone-15-pro&${site('https://example.com')}`);
  await frames[0].evaluate(() => {
    // Thrown asynchronously so it reaches window.onerror rather than the caller.
    setTimeout(() => {
      throw new Error('gonbi-test-error');
    }, 0);
  });
  await wait(1200);
  const errors = await viewer.evaluate(() => ({
    shown: !document.getElementById('errorBadge').hidden,
    text: document.getElementById('errorBadge').textContent,
  }));
  check('page errors surface in the status bar', errors.shown, errors.text);

  // ------------------------------------------------------- full-page capture --
  // A light background, so dark pixels at the edges can only be bezel.
  frames = await open(`device=iphone-15-pro&${site(COMPARE_SITE)}`);
  await viewer.evaluate(() =>
    document
      .getElementById('shot')
      .dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true })),
  );
  // A long page takes many capture passes. body[data-result] is read rather
  // than the status line, which expires after a few seconds.
  const fullPageNote = await until(
    () => viewer.evaluate(() => document.body.dataset.result ?? ''),
    (text) => /Full page saved|cut off|failed/.test(text),
  );
  const tall = Number(/\((\d+)px tall\)/.exec(fullPageNote)?.[1] ?? 0);
  check(
    'full-page capture stitches beyond one screen',
    tall > 764,
    fullPageNote || '(no result)',
  );

  /*
   * Inspect the pixels, not just the status line. Two bugs here were invisible
   * to a dimensions-only assertion:
   *   - stitching mixed screen pixels with page pixels, leaving gaps between
   *     slices on an over-tall canvas, yet the reported height stayed correct;
   *   - the bezel's rounded screen corners overlapped the iframe, so every
   *     slice contributed a dark sliver at its top edge.
   * An aspect matching total/deviceWidth catches the first; scanning the outer
   * columns for dark pixels catches the second, which is why this runs against a
   * light-backgrounded page.
   */
  await until(
    async () => fs.readdirSync(downloads).filter((f) => /fullpage.*\.png$/.test(f)),
    (files) => files.length > 0,
    30000,
  );
  const shot = fs
    .readdirSync(downloads)
    .filter((f) => /fullpage.*\.png$/.test(f))
    .sort()
    .pop();

  let ratioOk = false;
  let edgeOk = false;
  let ratioDetail = 'no file produced';
  let edgeDetail = 'no file produced';

  if (shot) {
    const png = PNG.sync.read(fs.readFileSync(path.join(downloads, shot)));
    const expected = tall / 393; // page height over the iPhone's CSS width
    const actual = png.height / png.width;
    ratioOk = Math.abs(actual - expected) / expected < 0.03;
    ratioDetail =
      `${shot} is ${png.width}x${png.height}, ` +
      `aspect ${actual.toFixed(1)} vs expected ${expected.toFixed(1)}`;

    const columns = [0, 1, 2, png.width - 3, png.width - 2, png.width - 1];
    let dark = 0;
    for (let y = 0; y < png.height; y++) {
      for (const x of columns) {
        const o = (y * png.width + x) * 4;
        if ((png.data[o] + png.data[o + 1] + png.data[o + 2]) / 3 < 90) dark++;
      }
    }
    const share = dark / (png.height * columns.length);
    edgeOk = share < 0.005;
    edgeDetail = `${(share * 100).toFixed(2)}% of the outer columns are dark`;
  }

  check('stitched image has consistent units', ratioOk, ratioDetail);
  check('no bezel slivers at slice boundaries', edgeOk, edgeDetail);
  check(
    'capture is named after the site',
    !!shot && shot.startsWith('en.wikipedia.org-'),
    shot ?? '(none)',
  );

  // --------------------------------------------------------------- recording --
  // tabCapture refuses without user activation, so this one needs real input
  // rather than a dispatched click.
  const realClick = async (selector) => {
    const point = await viewer.$eval(selector, (node) => {
      const r = node.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await viewer.mouse.click(point.x, point.y);
  };

  await realClick('#record');
  await wait(3000);
  const recording = await viewer.evaluate(() => ({
    on: document.getElementById('record').classList.contains('is-recording'),
    note: document.getElementById('note').textContent,
  }));
  await realClick('#record');
  await wait(2000);
  const stopped = await viewer.$eval(
    '#record',
    (b) => !b.classList.contains('is-recording'),
  );
  check(
    'recording starts and stops',
    recording.on && stopped,
    `started ${recording.on} ("${recording.note}"), stopped ${stopped}`,
  );

  // --------------------------------------------------------- accurate mode --
  frames = await open(`device=iphone-15-pro&${site('https://example.com')}`);
  const before = await frames[0].evaluate(() => ({
    dark: matchMedia('(prefers-color-scheme: dark)').matches,
    motion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  }));
  await clickIn(viewer, '#accurateToggle');
  await wait(1500);
  await viewer.select('#colorScheme', 'dark');
  await wait(1200);
  await viewer.evaluate(() => {
    const box = document.getElementById('reducedMotion');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
  });
  await wait(1200);
  await viewer.select('#vision', 'deuteranopia');
  await wait(1200);
  const after = await frames[0].evaluate(() => ({
    dark: matchMedia('(prefers-color-scheme: dark)').matches,
    motion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  }));
  check(
    'accurate mode emulates prefers-color-scheme: dark',
    before.dark === false && after.dark === true,
    `before ${before.dark}, after ${after.dark}`,
  );
  check(
    'accurate mode emulates prefers-reduced-motion',
    before.motion === false && after.motion === true,
    `before ${before.motion}, after ${after.motion}`,
  );
  // Detach before screenshotting: while chrome.debugger owns the tab, another
  // CDP client's Page.captureScreenshot does not come back.
  await clickIn(viewer, '#accurateToggle');
  await wait(1500);
  await viewer.screenshot({ path: path.join(SHOTS, 'viewer-accurate.png') });

  // ------------------------------------------------------------- device sets --
  await open(`devices=iphone-15-pro,macbook-air-13&${site('https://example.com')}`);
  await clickIn(viewer, '#saveSet');
  await wait(1200);
  const setName = await viewer.evaluate(() => document.body.dataset.result ?? '');

  const popup2 = await browser.newPage();
  await popup2.setViewport({ width: 372, height: 560 });
  await popup2.goto(`chrome-extension://${extId}/src/popup/popup.html`, {
    waitUntil: 'networkidle0',
  });
  await wait(800);
  const sets = await popup2.evaluate(() => ({
    rows: [...document.querySelectorAll('.row--set')].map(
      (r) => r.querySelector('.row__name').textContent,
    ),
    meta: document.querySelector('.row--set .row__meta')?.textContent ?? '',
  }));
  check(
    'saved set appears in the popup',
    sets.rows.some((row) => /iPhone 15 Pro \+ MacBook Air/.test(row)),
    `${sets.rows.join(' | ')} - ${sets.meta}`,
  );
  await popup2.screenshot({ path: path.join(SHOTS, 'popup-sets.png') });

  // Per-site memory is asserted against storage: the popup reads the *active*
  // tab, and in a test the popup page is itself the active tab.
  const siteMemory = await viewer.evaluate(async () => {
    const { siteDevices } = await chrome.storage.local.get('siteDevices');
    return siteDevices ?? {};
  });
  check(
    'devices are remembered per hostname',
    Array.isArray(siteMemory['example.com']) &&
      siteMemory['example.com'].length > 0 &&
      Array.isArray(siteMemory['github.com']),
    JSON.stringify(siteMemory),
  );
} finally {
  await browser.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
