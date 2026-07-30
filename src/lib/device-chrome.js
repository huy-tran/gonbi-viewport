/**
 * Simulated device UI - the operating-system and browser furniture that sits
 * between the screen edge and the web page on a real device.
 *
 * Without it a page renders flush to the top of the glass, tucked under the
 * notch or dynamic island, which never happens in reality: iOS and Android
 * reserve a status bar, modern phones reserve a home indicator, and on a laptop
 * the browser's own toolbar takes a slice off the top.
 *
 * Reserving that space also makes the page viewport more honest. A real iPhone
 * 15 Pro is a 393x852 screen but only ever gives a web page about 393x764.
 */

import { renderIcon } from './icon.js';

/** Portrait aspect at or above which an iPhone has a notch / dynamic island. */
const NOTCH_ASPECT = 1.9;
/** Long:short ratio at or above which a tablet is home-button-less. */
const MODERN_TABLET_ASPECT = 1.4;

const NONE = { top: null, bottom: null };

/**
 * Bars to reserve for `device`, in device CSS pixels.
 * Everything is derived from the catalogue rather than hand-annotated per
 * device: the aspect ratio reliably separates notched phones from home-button
 * ones, and modern tablets from the 4:3 generation.
 */
export function chromeFor(device, rotated = false) {
  if (/SMART-TV/.test(device.ua)) return NONE;

  if (device.category === 'laptop' || device.category === 'desktop') {
    return { top: { kind: 'browser', height: 46 }, bottom: null };
  }

  const apple = /iPhone|iPad/.test(device.ua);
  const long = Math.max(device.width, device.height);
  const short = Math.min(device.width, device.height);

  if (device.category === 'tablet') {
    const modern = long / short >= MODERN_TABLET_ASPECT;
    return {
      top: { kind: apple ? 'ios-status' : 'android-status', height: 24 },
      bottom: modern ? { kind: apple ? 'ios-home' : 'android-nav', height: 20 } : null,
    };
  }

  const notched = long / short >= NOTCH_ASPECT;

  if (apple) {
    return {
      // Safari hides the status bar when an iPhone is held in landscape.
      top: rotated ? null : { kind: 'ios-status', height: notched ? 54 : 20 },
      bottom: notched ? { kind: 'ios-home', height: rotated ? 21 : 34 } : null,
    };
  }
  /*
   * 32 rather than the classic 24dp: every Android phone in this catalogue has
   * a punch-hole camera, and the bar has to clear it. The frame sizes the hole
   * from this number (see topFurniture in tools/build-frames.mjs), so the two
   * cannot drift apart.
   */
  return {
    top: { kind: 'android-status', height: 32 },
    bottom: { kind: 'android-nav', height: 24 },
  };
}

/** Devices you can physically turn. A laptop or a TV is not one of them. */
export function isRotatable(device) {
  return device.category === 'phone' || device.category === 'tablet';
}

const clockText = () =>
  new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url || 'new tab';
  }
}

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Markup for one bar. Sizes are expressed in device CSS pixels so they scale
 * with the frame when the stage is zoomed.
 */
export function renderBar(bar, { device, url }) {
  if (!bar) return '';

  switch (bar.kind) {
    case 'ios-status':
      return `
        <div class="bar bar--ios-status" style="--h:${bar.height}px">
          <span class="bar__time">${clockText()}</span>
          <span class="bar__glyphs">
            ${renderIcon('signal', { size: 15 })}
            ${renderIcon('wifi', { size: 15 })}
            ${renderIcon('battery', { size: 17 })}
          </span>
        </div>`;

    case 'android-status':
      return `
        <div class="bar bar--android-status" style="--h:${bar.height}px">
          <span class="bar__time">${clockText()}</span>
          <span class="bar__glyphs">
            ${renderIcon('wifi', { size: 12 })}
            ${renderIcon('signal', { size: 12 })}
            ${renderIcon('battery', { size: 13 })}
          </span>
        </div>`;

    case 'ios-home':
      return `<div class="bar bar--home" style="--h:${bar.height}px"><span class="bar__pill"></span></div>`;

    case 'android-nav':
      return `<div class="bar bar--nav" style="--h:${bar.height}px"><span class="bar__pill"></span></div>`;

    case 'browser': {
      const mac = /Macintosh/.test(device.ua);
      return `
        <div class="bar bar--browser" style="--h:${bar.height}px">
          <span class="bar__lights ${mac ? 'is-mac' : ''}">
            <i></i><i></i><i></i>
          </span>
          <span class="bar__omnibox">${escapeHtml(hostOf(url))}</span>
        </div>`;
    }

    default:
      return '';
  }
}
