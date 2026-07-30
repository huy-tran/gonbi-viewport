/**
 * Browser user agents per device platform.
 *
 * Each device in the catalogue carries the user agent of its *default* browser
 * (Safari on Apple hardware, Chrome elsewhere). Real sites often branch on the
 * browser as well as the device - iOS Chrome is Safari's engine wearing a
 * different UA, Samsung Internet ships its own quirks - so the viewer lets you
 * pick one, and the string is derived from the device rather than stored 61
 * times over.
 */

const CHROME_VERSION = '126.0.0.0';
const FIREFOX_VERSION = '126.0';
const SAFARI_IOS_VERSION = '17.0';

export function platformOf(device) {
  if (/iPhone/.test(device.ua)) return 'ios';
  if (/iPad/.test(device.ua)) return 'ipados';
  if (/Android/.test(device.ua)) return 'android';
  if (/Macintosh/.test(device.ua)) return 'macos';
  if (/Windows/.test(device.ua)) return 'windows';
  if (/SMART-TV/.test(device.ua)) return 'tizen';
  return 'unknown';
}

/** The Android model string baked into the catalogue UA, e.g. "Pixel 8". */
function androidModel(device) {
  return /Android [\d.]+; ([^)]+)\)/.exec(device.ua)?.[1] ?? 'Android';
}

function androidVersion(device) {
  return /Android ([\d.]+);/.exec(device.ua)?.[1] ?? '14';
}

const APPLE_MOBILE_TAIL = 'Mobile/15E148';

/**
 * Browsers offered per platform. The first entry is the platform default and
 * must reproduce the catalogue's own user agent.
 */
export const BROWSERS = {
  ios: [
    { id: 'safari', label: 'Safari', chromium: false },
    { id: 'chrome', label: 'Chrome', chromium: false },
    { id: 'firefox', label: 'Firefox', chromium: false },
    { id: 'edge', label: 'Edge', chromium: false },
  ],
  ipados: [
    { id: 'safari', label: 'Safari', chromium: false },
    { id: 'chrome', label: 'Chrome', chromium: false },
  ],
  android: [
    { id: 'chrome', label: 'Chrome', chromium: true },
    { id: 'samsung', label: 'Samsung Internet', chromium: true },
    { id: 'firefox', label: 'Firefox', chromium: false },
    { id: 'edge', label: 'Edge', chromium: true },
  ],
  macos: [
    { id: 'chrome', label: 'Chrome', chromium: true },
    { id: 'safari', label: 'Safari', chromium: false },
    { id: 'firefox', label: 'Firefox', chromium: false },
    { id: 'edge', label: 'Edge', chromium: true },
  ],
  windows: [
    { id: 'chrome', label: 'Chrome', chromium: true },
    { id: 'edge', label: 'Edge', chromium: true },
    { id: 'firefox', label: 'Firefox', chromium: false },
  ],
  tizen: [{ id: 'tizen', label: 'Tizen Browser', chromium: true }],
  unknown: [{ id: 'chrome', label: 'Chrome', chromium: true }],
};

export function browsersFor(device) {
  return BROWSERS[platformOf(device)] ?? BROWSERS.unknown;
}

export function defaultBrowserFor(device) {
  return browsersFor(device)[0].id;
}

/** Is `browserId` offered on this device? Used when switching devices. */
export function supportsBrowser(device, browserId) {
  return browsersFor(device).some((b) => b.id === browserId);
}

export function isChromium(device, browserId) {
  return browsersFor(device).find((b) => b.id === browserId)?.chromium ?? false;
}

/**
 * The user agent for a device/browser pair. Falls back to the catalogue string
 * for the platform default and for anything unrecognised.
 */
export function uaFor(device, browserId) {
  const platform = platformOf(device);
  if (!browserId || browserId === defaultBrowserFor(device)) return device.ua;

  switch (platform) {
    case 'ios':
    case 'ipados': {
      // All iOS browsers are WebKit with a different product token.
      const token = {
        chrome: `CriOS/${CHROME_VERSION}`,
        firefox: `FxiOS/${FIREFOX_VERSION}`,
        edge: `EdgiOS/${CHROME_VERSION}`,
      }[browserId];
      if (!token) return device.ua;
      return device.ua
        .replace(
          `Version/${SAFARI_IOS_VERSION} ${APPLE_MOBILE_TAIL}`,
          `${token} ${APPLE_MOBILE_TAIL}`,
        )
        .replace(/Version\/[\d.]+ /, `${token} `);
    }

    case 'android': {
      const model = androidModel(device);
      const version = androidVersion(device);
      const base = `Mozilla/5.0 (Linux; Android ${version}; ${model}) AppleWebKit/537.36 (KHTML, like Gecko)`;
      if (browserId === 'samsung')
        return `${base} SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36`;
      if (browserId === 'edge')
        return `${base} Chrome/${CHROME_VERSION} Mobile Safari/537.36 EdgA/${CHROME_VERSION}`;
      if (browserId === 'firefox')
        return `Mozilla/5.0 (Android ${version}; Mobile; rv:${FIREFOX_VERSION}) Gecko/${FIREFOX_VERSION} Firefox/${FIREFOX_VERSION}`;
      return device.ua;
    }

    case 'macos': {
      if (browserId === 'safari')
        return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
      if (browserId === 'firefox')
        return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:${FIREFOX_VERSION}) Gecko/20100101 Firefox/${FIREFOX_VERSION}`;
      if (browserId === 'edge') return `${device.ua} Edg/${CHROME_VERSION}`;
      return device.ua;
    }

    case 'windows': {
      if (browserId === 'edge') return `${device.ua} Edg/${CHROME_VERSION}`;
      if (browserId === 'firefox')
        return `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${FIREFOX_VERSION}) Gecko/20100101 Firefox/${FIREFOX_VERSION}`;
      return device.ua;
    }

    default:
      return device.ua;
  }
}
