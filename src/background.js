/**
 * Service worker.
 *
 * Three jobs:
 *
 *  1. Own the viewer tabs. The popup asks to open a device; we either reuse the
 *     viewer tab the request came from or open a new one.
 *
 *  2. Make the framed site behave like it is on the chosen device. Sites block
 *     framing with X-Frame-Options / CSP frame-ancestors, and serve desktop
 *     markup unless the User-Agent says otherwise. Both are fixed with
 *     declarativeNetRequest *session* rules scoped to a single tab id, so the
 *     relaxation never applies to normal browsing - only inside a viewer tab
 *     the user explicitly opened.
 *
 *  3. Tell the viewer what its iframe is doing. The viewer cannot read a
 *     cross-origin frame's location, so navigations inside the frame are
 *     relayed from webNavigation - without this the address bar, reload button
 *     and pop-out all keep pointing at the page you started on.
 */

import { DEVICE_BY_ID } from './data/devices.js';
import { uaFor, isChromium, platformOf } from './data/browsers.js';
import { emulateInFrame } from './inject/emulate.js';

const VIEWER_PATH = 'src/viewer/viewer.html';
const RULES_PER_TAB = 3;

/**
 * Rule ids must be small positive integers, so they cannot be derived from the
 * tab id - Chrome hands out ids large enough that `tabId * 3` overflows int32
 * and the whole updateSessionRules call is rejected. Instead each tab is given
 * the lowest free slot, tracked in session storage so the mapping survives a
 * service-worker restart.
 */
const SLOT_KEY = 'ruleSlots';
const VIEWERS_KEY = 'activeViewers';

async function readSlots() {
  const { [SLOT_KEY]: slots } = await chrome.storage.session.get(SLOT_KEY);
  return slots ?? {};
}

async function ruleIdsForTab(tabId, { create = false } = {}) {
  const slots = await readSlots();
  if (slots[tabId]) return slots[tabId];
  if (!create) return [];

  const used = new Set(Object.values(slots).flat());
  const ids = [];
  for (let candidate = 1; ids.length < RULES_PER_TAB; candidate++) {
    if (!used.has(candidate)) ids.push(candidate);
  }
  slots[tabId] = ids;
  await chrome.storage.session.set({ [SLOT_KEY]: slots });
  return ids;
}

async function releaseRuleIds(tabId) {
  const slots = await readSlots();
  delete slots[tabId];
  await chrome.storage.session.set({ [SLOT_KEY]: slots });
}

/**
 * Viewer tabs and what each is emulating. Kept in session storage rather than a
 * Map because the service worker is torn down between events and the navigation
 * listener needs this after a restart.
 */
async function readViewers() {
  const { [VIEWERS_KEY]: viewers } = await chrome.storage.session.get(VIEWERS_KEY);
  return viewers ?? {};
}

async function rememberViewer(tabId, patch) {
  const viewers = await readViewers();
  viewers[tabId] = { ...viewers[tabId], ...patch };
  await chrome.storage.session.set({ [VIEWERS_KEY]: viewers });
  return viewers[tabId];
}

async function forgetViewer(tabId) {
  const viewers = await readViewers();
  delete viewers[tabId];
  await chrome.storage.session.set({ [VIEWERS_KEY]: viewers });
}

/** Every sub-resource type a framed page can request, minus the top document. */
const SUB_RESOURCE_TYPES = [
  'sub_frame',
  'script',
  'stylesheet',
  'image',
  'font',
  'xmlhttprequest',
  'media',
  'websocket',
  'other',
];

/** Value for the Sec-CH-UA-Platform hint. */
const CH_PLATFORM = {
  ios: 'iOS',
  ipados: 'iOS',
  watchos: 'iOS',
  android: 'Android',
  macos: 'macOS',
  windows: 'Windows',
  tizen: 'Linux',
};

function platformFor(device) {
  return CH_PLATFORM[platformOf(device)] ?? 'Unknown';
}

/** Every device on screen in pane order; falls back to the leading one. */
function paneDevices(viewer) {
  const ids = viewer?.deviceIds?.length ? viewer.deviceIds : [viewer?.deviceId];
  const found = ids.map((id) => DEVICE_BY_ID.get(id)).filter(Boolean);
  return found.length ? found : [DEVICE_BY_ID.get(viewer.deviceId)].filter(Boolean);
}

/**
 * Install the header rules for `tabId` so the framed page loads and thinks it
 * is running on `device` in `browserId`. Replaces this tab's previous rules.
 */
async function applyDeviceRules(tabId, device, browserId) {
  const ids = await ruleIdsForTab(tabId, { create: true });
  const [frameRuleId, uaRuleId, hintsRuleId] = ids;
  const ua = uaFor(device, browserId);

  const addRules = [
    {
      // Let the page be framed at all.
      id: frameRuleId,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'x-frame-options', operation: 'remove' },
          { header: 'content-security-policy', operation: 'remove' },
          { header: 'content-security-policy-report-only', operation: 'remove' },
        ],
      },
      condition: { tabIds: [tabId], resourceTypes: ['sub_frame'] },
    },
    {
      // Server-side device detection.
      id: uaRuleId,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'user-agent', operation: 'set', value: ua }],
      },
      condition: { tabIds: [tabId], resourceTypes: SUB_RESOURCE_TYPES },
    },
    {
      // Client hints, for sites that prefer them over the UA string. Safari and
      // Firefox do not send these at all, so emulating them removes the headers
      // rather than setting them.
      id: hintsRuleId,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: isChromium(device, browserId)
          ? [
              {
                header: 'sec-ch-ua-mobile',
                operation: 'set',
                value: device.category === 'phone' ? '?1' : '?0',
              },
              {
                header: 'sec-ch-ua-platform',
                operation: 'set',
                value: `"${platformFor(device)}"`,
              },
            ]
          : [
              { header: 'sec-ch-ua', operation: 'remove' },
              { header: 'sec-ch-ua-mobile', operation: 'remove' },
              { header: 'sec-ch-ua-platform', operation: 'remove' },
            ],
      },
      condition: { tabIds: [tabId], resourceTypes: SUB_RESOURCE_TYPES },
    },
  ];

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: ids,
    addRules,
  });
}

async function clearDeviceRules(tabId) {
  try {
    const ids = await ruleIdsForTab(tabId);
    if (ids.length) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
    }
    await releaseRuleIds(tabId);
  } catch {
    /* tab already gone */
  }
}

function viewerUrl(deviceId, url, orientation) {
  const params = new URLSearchParams({ device: deviceId });
  if (url) params.set('url', url);
  if (orientation) params.set('orientation', orientation);
  return chrome.runtime.getURL(`${VIEWER_PATH}?${params}`);
}

/**
 * Extension pages in tabs receive runtime messages, not tab messages, so this
 * broadcasts and lets the viewer filter on its own tab id.
 */
function notifyViewer(tabId, message) {
  chrome.runtime.sendMessage({ ...message, tabId }).catch(() => {
    /* viewer closed or not listening yet */
  });
}

// ------------------------------------------------------------- accurate mode --

/**
 * Emulation that headers and injected script cannot do: real device pixel
 * ratio, prefers-color-scheme and network throttling. These need CDP, and the
 * framed site is a cross-origin iframe - an out-of-process target - so we
 * auto-attach to it and send the commands to that child session rather than to
 * the tab, whose main frame is the viewer's own toolbar.
 */
const attached = new Set();
/** tabId -> Set of child CDP session ids for its framed content. */
const childSessions = new Map();

const THROTTLE_PROFILES = {
  none: null,
  '3g': {
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
    latency: 150,
  },
  '4g': {
    downloadThroughput: (9 * 1024 * 1024) / 8,
    uploadThroughput: (9 * 1024 * 1024) / 8,
    latency: 60,
  },
  offline: { downloadThroughput: 0, uploadThroughput: 0, latency: 0, offline: true },
};

async function send(target, method, params) {
  try {
    return await chrome.debugger.sendCommand(target, method, params);
  } catch (err) {
    console.warn(`[gonbi] ${method} failed:`, err?.message ?? err);
    return null;
  }
}

/** A few well-known places, so geolocation testing needs no lat/lng lookup. */
export const GEO_PRESETS = {
  none: null,
  london: { latitude: 51.5074, longitude: -0.1278 },
  'new-york': { latitude: 40.7128, longitude: -74.006 },
  tokyo: { latitude: 35.6762, longitude: 139.6503 },
  sydney: { latitude: -33.8688, longitude: 151.2093 },
  'sao-paulo': { latitude: -23.5505, longitude: -46.6333 },
};

/** Push the current emulation settings to every framed child session. */
async function pushEmulation(tabId) {
  const viewer = (await readViewers())[tabId];
  if (!viewer?.accurate) return;
  const device = DEVICE_BY_ID.get(viewer.deviceId);
  const sessions = childSessions.get(tabId);
  if (!device || !sessions?.size) return;

  const panes = paneDevices(viewer);

  for (const sessionId of sessions) {
    const target = { tabId, sessionId };

    /*
     * Per-pane request headers. DNR cannot do this - its rules are tab-scoped -
     * but a CDP session belongs to exactly one frame, so asking that frame for
     * its window.name identifies which pane it is. Same identity trick the
     * injected script uses, so the header UA and the spoofed navigator agree.
     */
    if (panes.length > 1) {
      const named = await send(target, 'Runtime.evaluate', {
        expression: 'window.name',
        returnByValue: true,
      });
      const index = Number(
        /^gonbi-pane-(\d+)$/.exec(named?.result?.value ?? '')?.[1] ?? -1,
      );
      const paneDevice = index >= 0 ? panes[index] : null;
      if (paneDevice) {
        await send(target, 'Network.enable', {});
        await send(target, 'Network.setUserAgentOverride', {
          userAgent: uaFor(paneDevice, viewer.browserId),
        });
      }
    }
    // width/height 0 means "leave the size alone" - the frame is already sized
    // by CSS; only the pixel ratio is overridden.
    await send(target, 'Emulation.setDeviceMetricsOverride', {
      width: 0,
      height: 0,
      deviceScaleFactor: device.dpr,
      mobile: device.category === 'phone' || device.category === 'tablet',
    });

    const features = [
      { name: 'prefers-color-scheme', value: viewer.colorScheme || 'light' },
      {
        name: 'prefers-reduced-motion',
        value: viewer.reducedMotion ? 'reduce' : 'no-preference',
      },
      { name: 'forced-colors', value: viewer.forcedColors ? 'active' : 'none' },
    ];
    await send(target, 'Emulation.setEmulatedMedia', { features });

    await send(target, 'Emulation.setEmulatedVisionDeficiency', {
      type: viewer.vision && viewer.vision !== 'none' ? viewer.vision : 'none',
    });

    if (viewer.timezone) {
      await send(target, 'Emulation.setTimezoneOverride', {
        timezoneId: viewer.timezone,
      });
    }
    if (viewer.locale) {
      await send(target, 'Emulation.setLocaleOverride', { locale: viewer.locale });
    }

    const geo = GEO_PRESETS[viewer.geo || 'none'];
    if (geo) {
      await send(target, 'Emulation.setGeolocationOverride', { ...geo, accuracy: 20 });
    } else {
      await send(target, 'Emulation.clearGeolocationOverride', {});
    }

    const profile = THROTTLE_PROFILES[viewer.throttle || 'none'];
    await send(target, 'Network.enable', {});
    await send(target, 'Network.emulateNetworkConditions', {
      offline: profile?.offline ?? false,
      latency: profile?.latency ?? 0,
      downloadThroughput: profile ? profile.downloadThroughput : -1,
      uploadThroughput: profile ? profile.uploadThroughput : -1,
    });
  }
}

async function enableAccurate(tabId) {
  if (attached.has(tabId)) {
    await pushEmulation(tabId);
    return { ok: true };
  }
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
  attached.add(tabId);
  childSessions.set(tabId, new Set());
  // flatten:true reports child targets as sessions we can address directly.
  await send({ tabId }, 'Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  await pushEmulation(tabId);
  return { ok: true };
}

async function disableAccurate(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  childSessions.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* already gone */
  }
}

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (method !== 'Target.attachedToTarget') return;
  const tabId = source.tabId;
  if (tabId == null || !attached.has(tabId)) return;
  if (params?.targetInfo?.type !== 'iframe') return;

  const sessions = childSessions.get(tabId) ?? new Set();
  sessions.add(params.sessionId);
  childSessions.set(tabId, sessions);
  await pushEmulation(tabId);
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) {
    attached.delete(source.tabId);
    childSessions.delete(source.tabId);
    notifyViewer(source.tabId, { type: 'accurateDetached' });
  }
});

// ----------------------------------------------------------------- messages --

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'openViewer': {
        const device = DEVICE_BY_ID.get(msg.deviceId);
        if (!device) return sendResponse({ ok: false, error: 'unknown device' });

        // Reopening from inside a viewer tab replaces that tab rather than
        // stacking up windows.
        if (msg.reuseTabId != null) {
          await applyDeviceRules(msg.reuseTabId, device, msg.browserId);
          await rememberViewer(msg.reuseTabId, {
            deviceId: device.id,
            browserId: msg.browserId,
          });
          await chrome.tabs.update(msg.reuseTabId, {
            url: viewerUrl(device.id, msg.url, msg.orientation),
          });
          return sendResponse({ ok: true, tabId: msg.reuseTabId });
        }

        const tab = await chrome.tabs.create({
          url: viewerUrl(device.id, msg.url, msg.orientation),
        });
        await applyDeviceRules(tab.id, device, msg.browserId);
        await rememberViewer(tab.id, { deviceId: device.id, browserId: msg.browserId });
        return sendResponse({ ok: true, tabId: tab.id });
      }

      // The viewer calls this before it points the iframe anywhere, so the
      // rules are in place for the very first request.
      case 'armTab': {
        const device = DEVICE_BY_ID.get(msg.deviceId);
        const tabId = sender.tab?.id;
        if (!device || tabId == null)
          return sendResponse({ ok: false, error: 'no tab or device' });
        await applyDeviceRules(tabId, device, msg.browserId);
        await rememberViewer(tabId, {
          deviceId: device.id,
          deviceIds: Array.isArray(msg.deviceIds) ? msg.deviceIds : [device.id],
          browserId: msg.browserId,
          syncScroll: !!msg.syncScroll,
        });
        await pushEmulation(tabId);
        return sendResponse({ ok: true });
      }

      case 'setEmulation': {
        const tabId = sender.tab?.id;
        if (tabId == null) return sendResponse({ ok: false, error: 'no tab' });
        await rememberViewer(tabId, {
          accurate: msg.accurate,
          colorScheme: msg.colorScheme,
          throttle: msg.throttle,
          vision: msg.vision,
          reducedMotion: msg.reducedMotion,
          forcedColors: msg.forcedColors,
          timezone: msg.timezone,
          locale: msg.locale,
          geo: msg.geo,
        });
        if (msg.accurate) return sendResponse(await enableAccurate(tabId));
        await disableAccurate(tabId);
        return sendResponse({ ok: true });
      }

      case 'captureScreenshot': {
        const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' });
        return sendResponse({ ok: true, dataUrl });
      }

      // Recording runs in the viewer, but the stream id has to be minted here.
      case 'captureStreamId': {
        const tabId = sender.tab?.id;
        if (tabId == null) return sendResponse({ ok: false, error: 'no tab' });
        const streamId = await chrome.tabCapture.getMediaStreamId({
          targetTabId: tabId,
        });
        return sendResponse({ ok: true, streamId });
      }

      default:
        return sendResponse({ ok: false, error: `unknown message ${msg.type}` });
    }
  })().catch((err) => sendResponse({ ok: false, error: String(err) }));

  return true; // async response
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await disableAccurate(tabId);
  await forgetViewer(tabId);
  await clearDeviceRules(tabId);
});

// ------------------------------------------------------- framed page tracking --

/**
 * Spoof the client-side device signals inside the framed page, and tell the
 * viewer where the frame just went.
 */
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId === 0) return; // the viewer shell itself
  const viewer = (await readViewers())[details.tabId];
  if (!viewer) return;

  const device = DEVICE_BY_ID.get(viewer.deviceId);
  if (!device) return;

  // Only the frames the viewer itself created are the "page"; anything deeper
  // is the site's own iframes and must not move the address bar.
  if (details.parentFrameId === 0) {
    notifyViewer(details.tabId, { type: 'frameNavigated', url: details.url });
  }

  try {
    if (device.touch) {
      // A classic scrollbar eats ~15px of layout width, so a "393px" phone
      // would really lay out at 378 and trip media queries early. Real touch
      // devices use overlay scrollbars; removing it restores the full width.
      await chrome.scripting.insertCSS({
        target: { tabId: details.tabId, frameIds: [details.frameId] },
        css: '::-webkit-scrollbar{width:0!important;height:0!important;display:none!important}html{scrollbar-width:none!important}',
      });
    }

    // One injection, so nothing of the page can run between spoofing steps.
    // Every pane's config goes in; the script picks its own by iframe name.
    await chrome.scripting.executeScript({
      target: { tabId: details.tabId, frameIds: [details.frameId] },
      world: 'MAIN',
      injectImmediately: true,
      func: emulateInFrame,
      args: [
        {
          devices: paneDevices(viewer).map((d) => ({
            ua: uaFor(d, viewer.browserId),
            platform: platformFor(d),
            touch: d.touch,
            dpr: d.dpr,
          })),
          syncScroll: !!viewer.syncScroll,
        },
      ],
    });
  } catch {
    /* frame navigated away or is not scriptable */
  }
});

chrome.webNavigation.onErrorOccurred.addListener(async (details) => {
  if (details.frameId === 0 || details.parentFrameId !== 0) return;
  const viewer = (await readViewers())[details.tabId];
  if (!viewer) return;
  notifyViewer(details.tabId, {
    type: 'frameError',
    url: details.url,
    error: details.error,
  });
});
