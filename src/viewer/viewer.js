import { DEVICES, CATEGORIES, DEVICE_BY_ID } from '../data/devices.js';
import { FRAME_GEOMETRY } from '../data/frame-geometry.js';
import { browsersFor, defaultBrowserFor, supportsBrowser } from '../data/browsers.js';
import { hydrateIcons, renderIcon } from '../lib/icon.js';
import { renderBar, isRotatable } from '../lib/device-chrome.js';
import { computeGeometry, fitZoom } from './geometry.js';
import { createCapture, fileStem } from './capture.js';
import { createAudit } from './audit-ui.js';
import { parseBreakpoints, activeRange, describeRange } from '../lib/breakpoints.js';
import {
  getState,
  setState,
  pushRecent,
  saveSet,
  rememberSiteDevices,
} from '../lib/store.js';

const el = {};
for (const id of [
  'urlForm',
  'url',
  'back',
  'forward',
  'reload',
  'device',
  'deviceSizer',
  'browser',
  'compareToggle',
  'saveSet',
  'sizeW',
  'sizeH',
  'sizeReset',
  'rotate',
  'zoom',
  'frameToggle',
  'paneSizer',
  'uiToggle',
  'syncToggle',
  'accurateToggle',
  'emulationToggle',
  'shot',
  'record',
  'popout',
  'stage',
  'panes',
  'hint',
  'spec',
  'note',
  'errorBadge',
  'auditBadge',
  'auditPanel',
  'helpPanel',
  'breakpoints',
  'breakpointList',
  'breakpointNote',
  'emulationPanel',
  'emulationHint',
  'errorPanel',
  'colorScheme',
  'vision',
  'reducedMotion',
  'forcedColors',
  'throttle',
  'geo',
  'locale',
  'timezone',
]) {
  el[id] = document.getElementById(id);
}
el.template = document.getElementById('paneTemplate');
el.addTileTemplate = document.getElementById('addTileTemplate');
el.size = document.querySelector('.size');

/** Fit zoom keeps more panes usable than the old cap of four allowed. */
const MAX_PANES = 6;

/** Space the stage keeps around the frames, matching .stage padding. */
const STAGE_PADDING = 48;
const PANE_GAP = 28;

const params = new URLSearchParams(location.search);

/**
 * Devices on screen. The first is "primary": it drives the User-Agent, because
 * declarativeNetRequest rules are scoped to a tab and cannot differ per frame.
 */
let devices = readDevicesParam();
let currentUrl = params.get('url') || '';
let rotated = params.get('orientation') === 'rotated' && isRotatable(devices[0]);
let browserId = params.get('browser') || defaultBrowserFor(devices[0]);
/** Overrides the primary device's size when set, and hides its bezel. */
let customSize = readSizeParam();
let zoomMode = 'fit';
let showFrame = true;
let showDeviceUi = true;
let syncScroll = false;
/**
 * Comparison mode is explicit rather than inferred from the device count, so it
 * can be on with a single device and still offer the add tile.
 */
let comparing = params.get('compare') === '1' || devices.length > 1;

const emulation = {
  accurate: false,
  colorScheme: 'light',
  vision: 'none',
  reducedMotion: false,
  forcedColors: false,
  throttle: 'none',
  geo: 'none',
  locale: '',
  timezone: '',
};

let panes = [];
let ownTabId = null;
/** Scroll offset to restore after a reload of the same page. */
let pendingScroll = 0;
let auditResult = null;
let breakpoints = [];
let breakpointNote = '';
const pageErrors = [];

/** Session history of the framed page, driven by real frame navigations. */
const history_ = { stack: [], index: -1, replaying: false };

function readDevicesParam() {
  const ids = (params.get('devices') || params.get('device') || '')
    .split(',')
    .filter(Boolean);
  const found = ids.map((id) => DEVICE_BY_ID.get(id)).filter(Boolean);
  return found.length ? found : [DEVICES[0]];
}

function readSizeParam() {
  const w = Number(params.get('w'));
  const h = Number(params.get('h'));
  return w > 0 && h > 0 ? { w: Math.round(w), h: Math.round(h) } : null;
}

const primary = () => devices[0];

// ---------------------------------------------------------------- geometry --

/** Current state, in the shape computeGeometry expects. */
const geoState = (index) => ({
  index,
  rotated,
  showFrame,
  showDeviceUi,
  customSize,
});

const geometry = (device, index) =>
  computeGeometry(device, FRAME_GEOMETRY[device.id], geoState(index));

let currentZoom = 1;

// ------------------------------------------------------------------- panes --

/** Fill a <select> with every device, grouped by category. */
function fillDeviceOptions(select, { placeholder } = {}) {
  select.replaceChildren();
  if (placeholder) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = placeholder;
    select.append(option);
  }
  for (const cat of CATEGORIES) {
    const list = DEVICES.filter((d) => d.category === cat.id);
    if (!list.length) continue;
    const group = document.createElement('optgroup');
    group.label = cat.label;
    for (const d of list) {
      const option = document.createElement('option');
      option.value = d.id;
      option.textContent = `${d.brand} ${d.name}  ·  ${d.width}×${d.height}`;
      group.append(option);
    }
    select.append(group);
  }
}

/**
 * Size a select to its selected option. A native select is otherwise as wide as
 * its widest option, which for the device list is far too wide to sit inline.
 */
function fitSelect(select, sizer, padding) {
  const option = select.selectedOptions[0];
  if (!option) return;
  sizer.textContent = option.textContent;
  select.style.width = `${Math.ceil(sizer.getBoundingClientRect().width) + padding}px`;
}

function buildPanes() {
  el.panes.replaceChildren();
  panes = devices.map((device, index) => {
    const pane = createPane(device, index);
    el.panes.append(pane.root);
    return pane;
  });

  if (comparing && devices.length < MAX_PANES) el.panes.append(buildAddTile());
  el.panes.classList.toggle('is-compare', comparing);
}

function createPane(device, index) {
  const node = el.template.content.firstElementChild.cloneNode(true);
  const pane = {
    device,
    root: node,
    picker: node.querySelector('.pane__device'),
    size: node.querySelector('.pane__size'),
    close: node.querySelector('.pane__close'),
    sizer: node.querySelector('.sizer'),
    frame: node.querySelector('.frame'),
    viewport: node.querySelector('.frame__viewport'),
    art: node.querySelector('.frame__art'),
    screen: node.querySelector('.frame__screen'),
    chromeTop: node.querySelector('.frame__chrome--top'),
    chromeBottom: node.querySelector('.frame__chrome--bottom'),
    grip: node.querySelector('.grip'),
  };

  // The injected script reads window.name to know which device it is emulating,
  // which is how a comparison gets per-pane user agents.
  pane.screen.name = `gonbi-pane-${index}`;

  fillDeviceOptions(pane.picker);
  pane.picker.value = device.id;
  pane.picker.addEventListener('change', () => swapDevice(index, pane.picker.value));

  pane.close.hidden = devices.length < 2;
  pane.close.addEventListener('click', () => removeDevice(index));
  if (index === 0) attachGrip(pane);
  hydrateIcons(node);
  return pane;
}

/** The dashed tile that adds another device to the comparison. */
function buildAddTile() {
  const node = el.addTileTemplate.content.firstElementChild.cloneNode(true);
  const select = node.querySelector('.addtile__select');
  fillDeviceOptions(select, { placeholder: 'Add device…' });
  // Devices already on screen would be confusing duplicates.
  const taken = new Set(devices.map((d) => d.id));
  for (const option of select.querySelectorAll('option[value]')) {
    if (taken.has(option.value)) option.remove();
  }
  select.addEventListener('change', () => {
    const picked = DEVICE_BY_ID.get(select.value);
    if (picked) setDevices([...devices, picked]);
  });
  hydrateIcons(node);
  return node;
}

function layout() {
  const geos = panes.map((pane, index) => geometry(pane.device, index));
  const avail = {
    w: el.stage.clientWidth - STAGE_PADDING - PANE_GAP * (geos.length - 1),
    h: el.stage.clientHeight - STAGE_PADDING - 28, // pane label
  };
  const zoom =
    zoomMode === 'fit'
      ? fitZoom(
          geos.map((g) => g.box),
          avail,
        )
      : Number(zoomMode);
  currentZoom = zoom;

  panes.forEach((pane, index) => {
    const { box, screen, art, radius, ui, page } = geos[index];

    pane.sizer.style.width = `${box.w * zoom}px`;
    pane.sizer.style.height = `${box.h * zoom}px`;

    pane.frame.style.width = `${box.w}px`;
    pane.frame.style.height = `${box.h}px`;
    pane.frame.style.transform = `scale(${zoom})`;
    pane.frame.classList.toggle('is-bare', !art);

    // The clipped box covers the whole cutout; the page sits inside it, below
    // the status bar and above the home indicator.
    pane.viewport.style.left = `${screen.x}px`;
    pane.viewport.style.top = `${screen.y}px`;
    pane.viewport.style.width = `${screen.w}px`;
    pane.viewport.style.height = `${screen.h}px`;
    pane.viewport.style.borderRadius = radius ? `${radius}px` : '0';

    pane.screen.style.top = `${page.y}px`;
    pane.screen.style.width = `${page.w}px`;
    pane.screen.style.height = `${page.h}px`;

    pane.chromeTop.innerHTML = renderBar(ui.top, {
      device: pane.device,
      url: currentUrl,
    });
    pane.chromeBottom.innerHTML = renderBar(ui.bottom, {
      device: pane.device,
      url: currentUrl,
    });

    if (art) {
      pane.art.src = chrome.runtime.getURL(`assets/frames/${pane.device.id}.svg`);
      pane.art.style.width = `${art.w}px`;
      pane.art.style.height = `${art.h}px`;
      // translateY(-100%) then rotate about the origin lands the rotated image
      // back inside the box.
      pane.art.style.transform = art.rotate
        ? 'rotate(90deg) translateY(-100%)'
        : 'none';
    }

    pane.size.textContent =
      index === 0 && customSize ? `custom ${page.w}×${page.h}` : `${page.w}×${page.h}`;
    fitSelect(pane.picker, el.paneSizer, 26);
  });

  syncSizeFields(geos[0]);
  renderBreakpoints(geos[0].page.w);
  updateSpec(geos[0], zoom);
}

function syncSizeFields(geo) {
  if (document.activeElement !== el.sizeW)
    el.sizeW.value = String(Math.round(geo.screen.w));
  if (document.activeElement !== el.sizeH)
    el.sizeH.value = String(Math.round(geo.screen.h));
  el.size.classList.toggle('is-custom', !!customSize);
  el.sizeReset.hidden = !customSize;
}

function updateSpec(geo, zoom) {
  const device = primary();
  const dpr = Number.isInteger(device.dpr)
    ? device.dpr
    : device.dpr.toFixed(2).replace(/0+$/, '');
  // Read the orientation off the effective viewport - devices whose artwork is
  // natively landscape (laptops, iPads) are not "portrait" when unrotated.
  const orientation = geo.screen.w >= geo.screen.h ? 'landscape' : 'portrait';
  // With the device UI on, the page gets less than the full screen - report
  // what it actually has, and the screen size it was cut from.
  const size =
    geo.page.h === geo.screen.h
      ? `${geo.screen.w} × ${geo.screen.h} CSS px`
      : `${geo.page.w} × ${geo.page.h} page (${geo.screen.w} × ${geo.screen.h} screen)`;

  const lead = customSize
    ? `Custom on ${device.brand} ${device.name}`
    : devices.length > 1
      ? `${devices.length} devices - ${device.brand} ${device.name} leads`
      : `${device.brand} ${device.name}`;

  el.spec.textContent = `${lead} - ${size} · @${dpr}x · ${orientation} · zoom ${Math.round(zoom * 100)}%`;
}

// -------------------------------------------------------------- breakpoints --

function renderBreakpoints(width) {
  if (!breakpoints.length) {
    el.breakpoints.hidden = true;
    return;
  }
  el.breakpoints.hidden = false;
  const range = activeRange(breakpoints, width);

  el.breakpointList.replaceChildren();
  for (const bp of breakpoints) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = `${bp}`;
    chip.title = `Set width to ${bp}px - alt-click for ${bp - 1}px, just below the breakpoint`;
    chip.classList.toggle('is-active', bp === range.from);
    chip.addEventListener('click', (event) => {
      setCustomSize(event.altKey ? bp - 1 : bp, currentHeight());
    });
    el.breakpointList.append(chip);
  }

  el.breakpointNote.textContent = `${describeRange(range)}${breakpointNote}`;
}

function currentHeight() {
  const geo = geometry(primary(), 0);
  return Math.round(geo.screen.h);
}

// ------------------------------------------------------------ custom sizing --

function setCustomSize(w, h) {
  const width = Math.max(120, Math.min(4000, Math.round(w)));
  const height = Math.max(120, Math.min(4000, Math.round(h)));
  customSize = { w: width, h: height };
  syncAddress();
  layout();
  // Findings are width-specific, so they go stale the moment the size changes.
  scheduleAudit();
}

function clearCustomSize() {
  customSize = null;
  syncAddress();
  layout();
}

/** Drag the corner grip to size the leading pane freely. */
function attachGrip(pane) {
  pane.grip.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    pane.grip.setPointerCapture(event.pointerId);
    pane.grip.classList.add('is-dragging');

    const geo = geometry(pane.device, 0);
    const startW = geo.screen.w;
    const startH = geo.screen.h;
    const startX = event.clientX;
    const startY = event.clientY;

    const move = (moveEvent) => {
      // The frame is visually scaled, so screen pixels must be converted back.
      const dx = (moveEvent.clientX - startX) / currentZoom;
      const dy = (moveEvent.clientY - startY) / currentZoom;
      setCustomSize(startW + dx, startH + dy);
    };
    const up = () => {
      pane.grip.classList.remove('is-dragging');
      pane.grip.removeEventListener('pointermove', move);
      pane.grip.removeEventListener('pointerup', up);
    };
    pane.grip.addEventListener('pointermove', move);
    pane.grip.addEventListener('pointerup', up);
  });
}

const commitSizeFields = () => {
  const w = Number(el.sizeW.value);
  const h = Number(el.sizeH.value);
  if (w > 0 && h > 0) setCustomSize(w, h);
};
el.sizeW.addEventListener('change', commitSizeFields);
el.sizeH.addEventListener('change', commitSizeFields);
el.sizeReset.addEventListener('click', clearCustomSize);

// ----------------------------------------------------------------- loading --

function normalizeUrl(input) {
  const value = input.trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$|:)/i.test(value)) return `https://${value}`;
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

/** Reflect current state in the tab URL so reopening the popup sees it. */
function syncAddress() {
  const next = new URLSearchParams();
  next.set('devices', devices.map((d) => d.id).join(','));
  if (comparing) next.set('compare', '1');
  if (currentUrl) next.set('url', currentUrl);
  if (rotated) next.set('orientation', 'rotated');
  if (!showDeviceUi) next.set('ui', '0');
  if (browserId !== defaultBrowserFor(primary())) next.set('browser', browserId);
  if (customSize) {
    next.set('w', String(customSize.w));
    next.set('h', String(customSize.h));
  }
  history.replaceState(null, '', `${location.pathname}?${next}`);
}

let failureTimer;

async function load(url, { force = false, fromHistory = false } = {}) {
  const sameUrl = url === currentUrl;
  currentUrl = url;
  el.url.value = url;
  syncAddress();
  clearFailure();
  breakpoints = [];
  breakpointNote = '';
  pageErrors.length = 0;
  audit.reset();
  renderErrors();

  if (!url) {
    el.panes.hidden = true;
    el.hint.hidden = false;
    el.hint.textContent = 'Enter a URL above to preview it on this device.';
    return;
  }

  el.panes.hidden = false;
  el.hint.hidden = true;

  // Switching device or rotating reloads the same page; remember where the
  // reader was so they are not thrown back to the top every time.
  if (force && !fromHistory && sameUrl && panes[0]) {
    const before = await measure(panes[0]);
    pendingScroll = before?.scrollY || 0;
  } else {
    pendingScroll = 0;
  }

  const armed = await chrome.runtime.sendMessage({
    type: 'armTab',
    deviceId: primary().id,
    deviceIds: devices.map((d) => d.id),
    browserId,
    syncScroll,
  });
  if (!armed?.ok) {
    // Without the header rules the page loads as desktop, or not at all - say
    // so rather than silently showing a misleading result.
    flash(`Emulation not armed: ${armed?.error ?? 'no response'}`, true);
  }

  history_.replaying = fromHistory;
  for (const pane of panes) {
    if (force || pane.screen.src !== url) {
      // Assigning the same src is a no-op, so blank it first to force a reload.
      pane.screen.src = 'about:blank';
      pane.screen.src = url;
    }
  }

  rememberSiteDevices(
    url,
    devices.map((d) => d.id),
  );
  failureTimer = setTimeout(() => showFailure(url), 8000);
  layout();
}

function clearFailure() {
  clearTimeout(failureTimer);
  document.getElementById('failure')?.remove();
}

function showFailure(url) {
  if (document.getElementById('failure')) return;
  const box = document.createElement('div');
  box.id = 'failure';
  box.className = 'failure';
  box.innerHTML = `
    <span class="failure__icon">${renderIcon('warning', { size: 22 })}</span>
    <p class="failure__title">This site refused to load in a frame</p>
    <p class="failure__body">
      Header blocking is stripped automatically, but some sites also check in
      JavaScript whether they are framed and refuse anyway.
    </p>
    <button type="button" class="failure__action" id="failureOpen">Open in a normal tab</button>`;
  el.stage.append(box);
  document.getElementById('failureOpen').addEventListener('click', () => {
    if (currentUrl) chrome.tabs.create({ url: currentUrl });
  });
}

/** A real navigation happened inside the frame - keep everything in step. */
function onFrameNavigated(url) {
  if (!url || url === 'about:blank') return;
  clearFailure();
  currentUrl = url;
  el.url.value = url;
  syncAddress();

  if (!history_.replaying) {
    history_.stack = history_.stack.slice(0, history_.index + 1);
    if (history_.stack[history_.index] !== url) {
      history_.stack.push(url);
      history_.index = history_.stack.length - 1;
    }
  }
  history_.replaying = false;
  updateControls();

  if (pendingScroll) {
    const y = pendingScroll;
    pendingScroll = 0;
    // The page needs a moment to lay out before it can scroll that far.
    setTimeout(() => {
      for (const pane of panes) {
        pane.screen.contentWindow?.postMessage({ __gonbi: 'scrollTo', x: 0, y }, '*');
      }
    }, 700);
  }
  scheduleAudit();

  // The simulated browser bar shows the host, so it has to be redrawn.
  panes.forEach((pane, index) => {
    const geo = geometry(pane.device, index);
    if (geo.ui.top?.kind === 'browser') {
      pane.chromeTop.innerHTML = renderBar(geo.ui.top, {
        device: pane.device,
        url,
      });
    }
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.tabId !== ownTabId) return;
  if (msg.type === 'frameNavigated') onFrameNavigated(msg.url);
  else if (msg.type === 'frameError') showFailure(msg.url);
  else if (msg.type === 'accurateDetached') {
    emulation.accurate = false;
    paintToggle(el.accurateToggle, false);
    updateControls();
    flash('Accurate mode stopped', true);
  }
});

// ------------------------------------------------- messages from the frames --

/** Outstanding measure requests, keyed by id. */
const rpc = new Map();
let rpcId = 0;

/** Ask a framed page something and wait for its reply, or null on timeout. */
function request(pane, kind, timeout = 4000) {
  return new Promise((resolve) => {
    const id = ++rpcId;
    rpc.set(id, resolve);
    pane.screen.contentWindow?.postMessage({ __gonbi: kind, id }, '*');
    setTimeout(() => {
      if (rpc.delete(id)) resolve(null);
    }, timeout);
  });
}

const measure = (pane) => request(pane, 'measure', 2000);

window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  switch (data.__gonbi) {
    case 'metrics':
    case 'audit': {
      const resolve = rpc.get(data.id);
      if (resolve) {
        rpc.delete(data.id);
        resolve(data);
      }
      break;
    }
    case 'scroll': {
      if (!syncScroll) break;
      for (const pane of panes) {
        if (pane.screen.contentWindow === event.source) continue;
        // `path` names an inner scroll container when the page itself is not
        // what moved; the other panes look up the same node.
        pane.screen.contentWindow?.postMessage(
          { __gonbi: 'scrollTo', x: data.x, y: data.y, path: data.path ?? null },
          '*',
        );
      }
      break;
    }
    case 'breakpoints': {
      // Only the leading pane's report drives the strip; the panes all show the
      // same page, so a second report would just duplicate it.
      if (event.source !== panes[0]?.screen.contentWindow) break;
      breakpoints = parseBreakpoints(data.conditions);
      breakpointNote = data.unreadable
        ? ` · ${data.unreadable} cross-origin stylesheet${data.unreadable === 1 ? '' : 's'} unreadable`
        : '';
      renderBreakpoints(geometry(primary(), 0).page.w);
      break;
    }
    case 'stale': {
      // The framed page changed, so any findings describe a layout that is gone.
      if (event.source === panes[0]?.screen.contentWindow) audit.markStale();
      break;
    }
    case 'pageError': {
      if (event.source !== panes[0]?.screen.contentWindow) break;
      if (!pageErrors.includes(data.message)) pageErrors.push(data.message);
      renderErrors();
      break;
    }
  }
});

// -------------------------------------------------------------------- audit --

/**
 * Set the leading pane's width without scheduling an audit.
 *
 * The sweep drives the width itself and audits deliberately at each step; going
 * through setCustomSize would queue a debounced audit per step and fight it.
 * Accepts a number, a {w,h} to restore, or null to drop the override.
 */
function applyWidth(width) {
  if (width === null) {
    customSize = null;
  } else if (typeof width === 'object') {
    customSize = { ...width };
  } else {
    const height = Math.round(geometry(primary(), 0).screen.h);
    customSize = { w: Math.max(120, Math.min(4000, Math.round(width))), h: height };
  }
  syncAddress();
  layout();
}

const audit = createAudit({
  panel: el.auditPanel,
  badge: el.auditBadge,
  panes: () => panes,
  primary,
  url: () => currentUrl,
  request,
  highlight: (key) =>
    panes[0]?.screen.contentWindow?.postMessage({ __gonbi: 'highlight', key }, '*'),
  breakpoints: () => breakpoints,
  currentWidth: () => (customSize ? { ...customSize } : null),
  setWidth: applyWidth,
  download: downloadText,
  flash: (message, warn) => flash(message, warn),
  fileName: (suffix) => fileStem(currentUrl, devices, suffix),
});

const scheduleAudit = (delay) => audit.schedule(delay);

function downloadText(name, text) {
  const link = document.createElement('a');
  link.download = name;
  link.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}

function renderErrors() {
  el.errorBadge.hidden = pageErrors.length === 0;
  el.errorBadge.textContent = `${pageErrors.length} page error${pageErrors.length === 1 ? '' : 's'}`;
  if (!pageErrors.length) {
    el.errorPanel.hidden = true;
    el.errorBadge.setAttribute('aria-expanded', 'false');
  }
  if (!el.errorPanel.hidden) {
    el.errorPanel.replaceChildren();
    const list = document.createElement('ol');
    for (const message of pageErrors) {
      const item = document.createElement('li');
      item.textContent = message;
      list.append(item);
    }
    el.errorPanel.append(list);
  }
}

el.errorBadge.addEventListener('click', () => {
  el.errorPanel.hidden = !el.errorPanel.hidden;
  el.errorBadge.setAttribute('aria-expanded', String(!el.errorPanel.hidden));
  renderErrors();
});

// ---------------------------------------------------------------- controls --

function paintToggle(button, on) {
  button.classList.toggle('is-on', on);
  button.setAttribute('aria-pressed', String(on));
}

function buildDeviceSelect() {
  fillDeviceOptions(el.device);
  el.device.value = primary().id;
  fitDeviceSelect();
}

/** Widen the device select so the selected option is never truncated. */
const fitDeviceSelect = () => fitSelect(el.device, el.deviceSizer, 38);

function buildBrowserSelect() {
  const list = browsersFor(primary());
  el.browser.replaceChildren();
  for (const b of list) {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = b.label;
    el.browser.append(opt);
  }
  if (!supportsBrowser(primary(), browserId)) browserId = defaultBrowserFor(primary());
  el.browser.value = browserId;
  el.browser.disabled = list.length < 2;
}

function updateControls() {
  const canRotate = isRotatable(primary()) || !!customSize;
  el.rotate.disabled = !canRotate;
  el.rotate.title = canRotate
    ? 'Rotate (Shift+R)'
    : `A ${primary().category} does not rotate`;

  el.back.disabled = history_.index <= 0;
  el.forward.disabled = history_.index >= history_.stack.length - 1;

  el.syncToggle.hidden = devices.length < 2;
  // In comparison mode each pane carries its own picker, so the toolbar's would
  // be a second control for the same thing.
  el.device.hidden = comparing;

  const on = emulation.accurate;
  for (const control of [
    el.colorScheme,
    el.vision,
    el.reducedMotion,
    el.forcedColors,
    el.throttle,
    el.geo,
    el.locale,
    el.timezone,
  ]) {
    control.disabled = !on;
  }
  el.emulationHint.textContent = on
    ? 'Accurate mode is on - these are applied to the framed page.'
    : 'These need accurate mode, which is currently off.';
  el.emulationHint.classList.toggle('is-ok', on);
}

async function setDevices(next, { reload = true } = {}) {
  devices = next;
  if (!isRotatable(primary()) && !customSize) rotated = false;
  buildBrowserSelect();
  el.device.value = primary().id;
  fitDeviceSelect();
  buildPanes();
  updateControls();
  updateNote();
  syncAddress();
  if (reload) await load(currentUrl, { force: true });
  else layout();
}

function removeDevice(index) {
  if (devices.length < 2) return;
  setDevices(
    devices.filter((_, i) => i !== index),
    { reload: false },
  );
}

el.device.addEventListener('change', async () => {
  const picked = DEVICE_BY_ID.get(el.device.value);
  if (!picked) return;
  customSize = null;
  await pushRecent(picked.id);
  await setDevices([picked, ...devices.slice(1)]);
});

/**
 * Replace one pane's device, leaving the rest of the comparison alone.
 *
 * Swapping a trailing pane rebuilds only that pane, so the other iframes keep
 * their scroll position and page state. The leading pane is different: it drives
 * the tab's header User-Agent, so changing it makes every pane's markup stale
 * and they all have to reload.
 */
async function swapDevice(index, deviceId) {
  const picked = DEVICE_BY_ID.get(deviceId);
  if (!picked) return;
  await pushRecent(picked.id);

  if (index === 0) {
    // Resizing followed the leading pane and no longer describes this device.
    customSize = null;
    await setDevices([picked, ...devices.slice(1)]);
    return;
  }

  devices = devices.map((d, i) => (i === index ? picked : d));
  const fresh = createPane(picked, index);
  panes[index].root.replaceWith(fresh.root);
  panes[index] = fresh;

  await chrome.runtime.sendMessage({
    type: 'armTab',
    deviceId: primary().id,
    deviceIds: devices.map((d) => d.id),
    browserId,
    syncScroll,
  });
  if (currentUrl) fresh.screen.src = currentUrl;

  updateControls();
  updateNote();
  syncAddress();
  layout();
}

el.compareToggle.addEventListener('click', async () => {
  comparing = !comparing;
  paintToggle(el.compareToggle, comparing);
  await setState({ comparing });
  // Leaving the mode collapses back to the device that was driving the UA.
  // Either way the leading device is unchanged, so nothing needs reloading.
  await setDevices(comparing ? devices : [primary()], { reload: false });
});

el.saveSet.addEventListener('click', async () => {
  // Named from its devices rather than prompting: one click, no dialog, and the
  // popup can delete a set you no longer want.
  const name = devices.map((d) => d.name).join(' + ');
  await saveSet(
    name,
    devices.map((d) => d.id),
  );
  flash(`Saved set “${name}”`);
});

el.browser.addEventListener('change', async () => {
  browserId = el.browser.value;
  await setState({ browserId });
  await load(currentUrl, { force: true });
});

el.urlForm.addEventListener('submit', (event) => {
  event.preventDefault();
  load(normalizeUrl(el.url.value), { force: true });
  el.url.blur();
});

el.reload.addEventListener('click', () => load(currentUrl, { force: true }));

el.back.addEventListener('click', () => {
  if (history_.index <= 0) return;
  history_.index--;
  load(history_.stack[history_.index], { force: true, fromHistory: true });
  updateControls();
});

el.forward.addEventListener('click', () => {
  if (history_.index >= history_.stack.length - 1) return;
  history_.index++;
  load(history_.stack[history_.index], { force: true, fromHistory: true });
  updateControls();
});

el.rotate.addEventListener('click', () => {
  if (!isRotatable(primary()) && !customSize) return;
  rotated = !rotated;
  syncAddress();
  layout();
});

el.zoom.addEventListener('change', () => {
  zoomMode = el.zoom.value;
  setState({ zoom: zoomMode });
  layout();
});

el.frameToggle.addEventListener('click', () => {
  showFrame = !showFrame;
  paintToggle(el.frameToggle, showFrame);
  setState({ showFrame });
  layout();
});

el.uiToggle.addEventListener('click', () => {
  showDeviceUi = !showDeviceUi;
  paintToggle(el.uiToggle, showDeviceUi);
  setState({ showDeviceUi });
  syncAddress();
  layout();
});

el.syncToggle.addEventListener('click', async () => {
  syncScroll = !syncScroll;
  paintToggle(el.syncToggle, syncScroll);
  await setState({ syncScroll });
  // The injected script decides at load time whether to report scrolling.
  await load(currentUrl, { force: true });
});

// ------------------------------------------------------------- emulation ----

async function pushEmulation() {
  const response = await chrome.runtime.sendMessage({
    type: 'setEmulation',
    ...emulation,
  });
  if (!response?.ok && emulation.accurate) {
    emulation.accurate = false;
    paintToggle(el.accurateToggle, false);
    updateControls();
    flash(`Accurate mode failed: ${response?.error ?? 'unknown'}`, true);
  }
  return response;
}

el.accurateToggle.addEventListener('click', async () => {
  emulation.accurate = !emulation.accurate;
  paintToggle(el.accurateToggle, emulation.accurate);
  updateControls();
  const response = await pushEmulation();
  if (response?.ok) {
    flash(
      emulation.accurate
        ? 'Accurate mode on - Chrome will show a debugging banner'
        : 'Accurate mode off',
    );
  }
  updateNote();
});

el.emulationToggle.addEventListener('click', () => {
  el.emulationPanel.hidden = !el.emulationPanel.hidden;
  el.emulationToggle.setAttribute('aria-expanded', String(!el.emulationPanel.hidden));
});

for (const [key, control] of [
  ['colorScheme', el.colorScheme],
  ['vision', el.vision],
  ['throttle', el.throttle],
  ['geo', el.geo],
  ['locale', el.locale],
  ['timezone', el.timezone],
]) {
  control.addEventListener('change', () => {
    emulation[key] = control.value;
    pushEmulation();
  });
}
for (const [key, control] of [
  ['reducedMotion', el.reducedMotion],
  ['forcedColors', el.forcedColors],
]) {
  control.addEventListener('change', () => {
    emulation[key] = control.checked;
    pushEmulation();
  });
}

el.popout.addEventListener('click', () => {
  if (currentUrl) chrome.tabs.create({ url: currentUrl });
});

// ------------------------------------------------------------- screenshots --

const capture = createCapture({
  stage: el.stage,
  panesEl: el.panes,
  panes: () => panes,
  devices: () => devices,
  url: () => currentUrl,
  rotated: () => rotated,
  zoom: {
    get: () => zoomMode,
    set: (mode) => {
      zoomMode = mode;
      el.zoom.value = mode;
    },
  },
  currentZoom: () => currentZoom,
  layout,
  capture: async () => {
    const response = await chrome.runtime.sendMessage({ type: 'captureScreenshot' });
    if (!response?.ok) throw new Error(response?.error ?? 'capture failed');
    const img = new Image();
    img.src = response.dataUrl;
    await img.decode();
    return img;
  },
  streamId: async () => {
    const response = await chrome.runtime.sendMessage({ type: 'captureStreamId' });
    return response?.ok ? response.streamId : null;
  },
  measure,
  send: (pane, message) => pane.screen.contentWindow?.postMessage(message, '*'),
  flash: (message, warn) => flash(message, warn),
  onRecordingChange: (active, status) => {
    el.record.classList.toggle('is-recording', active);
    el.record.setAttribute('aria-pressed', String(active));
    el.record.innerHTML = renderIcon(active ? 'stop' : 'record', { size: 16 });
    if (active && status) {
      el.note.classList.remove('is-warn');
      el.note.textContent = status;
    } else if (!active) {
      flash('Recording saved');
    }
  },
});

el.shot.addEventListener('click', (event) => {
  if (event.shiftKey) capture.fullPageScreenshot();
  else capture.screenshot();
});

el.record.addEventListener('click', () => capture.toggleRecording());

el.popout.addEventListener('click', () => {
  if (currentUrl) chrome.tabs.create({ url: currentUrl });
});

// ------------------------------------------------------------------ status --

let flashTimer;
function flash(message, warn = false) {
  // Also recorded on the body, where it does not expire: long operations like a
  // full-page capture finish well after a transient status line has cleared.
  document.body.dataset.result = message;
  if (capture.isRecording()) return; // the timer owns the line while recording
  clearTimeout(flashTimer);
  el.note.textContent = message;
  el.note.classList.toggle('is-warn', warn);
  flashTimer = setTimeout(updateNote, 4000);
}

function updateNote() {
  if (capture.isRecording()) return;
  el.note.classList.remove('is-warn');
  const parts = [primary().touch ? 'Touch' : 'Mouse', 'UA spoofed'];
  if (devices.length > 1) parts.push(`UA follows ${primary().name}`);
  if (emulation.accurate) parts.push('accurate mode');
  el.note.textContent = parts.join(' · ');
}

// --------------------------------------------------------------- shortcuts --

/**
 * One table drives both the key handler and the help overlay, so the two cannot
 * drift apart - which they would, given there are a dozen of them and nothing
 * else advertises their existence.
 */
const SHORTCUTS = [
  { keys: ['r'], label: 'Reload the framed page', run: () => el.reload.click() },
  {
    keys: ['ArrowLeft'],
    alt: true,
    label: 'Back',
    display: 'Alt+Left',
    run: () => el.back.click(),
  },
  {
    keys: ['ArrowRight'],
    alt: true,
    label: 'Forward',
    display: 'Alt+Right',
    run: () => el.forward.click(),
  },
  { keys: ['r'], shift: true, label: 'Rotate', run: () => el.rotate.click() },
  { keys: ['c'], label: 'Comparison mode', run: () => el.compareToggle.click() },
  {
    keys: ['y'],
    label: 'Sync scrolling across devices',
    run: () => !el.syncToggle.hidden && el.syncToggle.click(),
  },
  {
    keys: ['f'],
    label: 'Show or hide the device frame',
    run: () => el.frameToggle.click(),
  },
  { keys: ['u'], label: 'Show or hide the device UI', run: () => el.uiToggle.click() },
  { keys: ['i'], label: 'Responsive issues', run: () => el.auditBadge.click() },
  { keys: ['e'], label: 'Emulation options', run: () => el.emulationToggle.click() },
  {
    keys: ['d'],
    label: 'Toggle emulated dark mode',
    run: () => {
      el.colorScheme.value = el.colorScheme.value === 'dark' ? 'light' : 'dark';
      el.colorScheme.dispatchEvent(new Event('change'));
    },
  },
  { keys: ['s'], label: 'Screenshot the devices', run: () => capture.screenshot() },
  {
    keys: ['s'],
    shift: true,
    label: 'Screenshot the full page',
    run: () => capture.fullPageScreenshot(),
  },
  { keys: ['v'], label: 'Start or stop recording', run: () => el.record.click() },
  {
    keys: ['l'],
    label: 'Focus the URL bar',
    run: () => {
      el.url.focus();
      el.url.select();
    },
  },
  { keys: ['?', '/'], shift: null, label: 'This list', display: '?', run: toggleHelp },
];

const displayKeys = (shortcut) =>
  shortcut.display ??
  `${shortcut.shift ? 'Shift+' : ''}${shortcut.keys[0].toUpperCase()}`;

function toggleHelp() {
  const open = el.helpPanel.hidden;
  el.helpPanel.hidden = !open;
  if (!open) return;

  el.helpPanel.replaceChildren();
  const title = document.createElement('p');
  title.className = 'panel__hint is-ok';
  title.textContent = 'Keyboard shortcuts. Press ? or Escape to close.';
  el.helpPanel.append(title);

  const list = document.createElement('dl');
  list.className = 'help__list';
  for (const shortcut of SHORTCUTS) {
    const key = document.createElement('dt');
    key.textContent = displayKeys(shortcut);
    const what = document.createElement('dd');
    what.textContent = shortcut.label;
    list.append(key, what);
  }
  el.helpPanel.append(list);

  const note = document.createElement('p');
  note.className = 'audit__note';
  note.textContent =
    'If a shortcut does nothing, focus is inside the framed page - a cross-origin ' +
    'frame swallows the keydown. Click the stage background first.';
  el.helpPanel.append(note);
}

/**
 * Every dismissible panel, paired with the control whose state it reflects.
 * Closing a panel without clearing its control leaves the control looking
 * pressed over a panel that is no longer there.
 */
const PANELS = [
  [el.helpPanel, null],
  [el.auditPanel, el.auditBadge],
  [el.emulationPanel, el.emulationToggle],
  [el.errorPanel, el.errorBadge],
];

function closePanels() {
  for (const [panel, owner] of PANELS) {
    panel.hidden = true;
    owner?.setAttribute('aria-expanded', 'false');
  }
}

document.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey) return;
  // Typing in a field must never trigger a shortcut.
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;

  if (event.key === 'Escape') {
    closePanels();
    return;
  }

  const match = SHORTCUTS.find(
    (s) =>
      s.keys.some((k) => k.toLowerCase() === event.key.toLowerCase()) &&
      (s.shift === null || !!s.shift === event.shiftKey) &&
      !!s.alt === event.altKey,
  );
  if (!match) return;
  event.preventDefault();
  match.run();
});

let resizeTimer;
window.addEventListener('resize', () => {
  if (zoomMode !== 'fit') return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(layout, 80);
});
// --------------------------------------------------------------------- init --

(async () => {
  hydrateIcons();
  ownTabId = (await chrome.tabs.getCurrent())?.id ?? null;

  const saved = await getState();
  zoomMode = saved.zoom ?? 'fit';
  showFrame = saved.showFrame ?? true;
  syncScroll = saved.syncScroll ?? false;
  // An explicit ?ui= in the address wins over the stored preference, so a
  // viewer link can pin the device UI on or off.
  showDeviceUi = params.has('ui')
    ? params.get('ui') !== '0'
    : (saved.showDeviceUi ?? true);

  // A multi-device address or set wins; otherwise fall back to the preference.
  if (!params.has('compare') && devices.length < 2)
    comparing = saved.comparing ?? false;

  el.zoom.value = zoomMode;
  paintToggle(el.frameToggle, showFrame);
  paintToggle(el.uiToggle, showDeviceUi);
  paintToggle(el.syncToggle, syncScroll);
  paintToggle(el.compareToggle, comparing);

  buildDeviceSelect();
  buildBrowserSelect();
  buildPanes();
  updateControls();
  updateNote();
  await load(currentUrl);
  layout();
})();
