/**
 * What the right-click menu offers, and what a click on it was aimed at.
 *
 * The service worker owns the chrome.contextMenus calls, which cannot be run
 * outside a browser; the decisions those calls are made from live here, where
 * tests can reach them.
 */

import { DEVICE_BY_ID } from '../data/devices.js';

/** Offered before anything has been opened, so the submenu is never empty. */
export const STARTER_DEVICE_IDS = ['iphone-15-pro', 'ipad-air-4', 'macbook-air-13'];

/** A submenu is a glance, not a catalogue; the popup is there for the rest. */
export const MAX_MENU_DEVICES = 8;

/**
 * Devices to offer, most useful first: the one used last, then favourites, then
 * recents. Ids that are no longer in the catalogue are dropped, so a device
 * retired in an update cannot leave a menu entry that opens nothing.
 */
export function menuDeviceIds({
  lastDeviceId = null,
  favourites = [],
  recents = [],
} = {}) {
  const ordered = [lastDeviceId, ...favourites, ...recents].filter(Boolean);
  const known = [...new Set(ordered)].filter((id) => DEVICE_BY_ID.has(id));
  const offered = known.length ? known : STARTER_DEVICE_IDS;
  return offered.filter((id) => DEVICE_BY_ID.has(id)).slice(0, MAX_MENU_DEVICES);
}

/**
 * What a menu click was aimed at.
 *
 * A link wins over the page it sits on. Otherwise it is the page - and when
 * that page is a viewer, it is the site being framed rather than the viewer's
 * own address, so "show me this one on another device" works from inside one.
 *
 * Anything unframable resolves to '', which opens an empty viewer asking for a
 * URL. That is a better answer than silently doing nothing when the click
 * landed on a chrome:// page or a blank tab.
 */
export function targetUrlOf(info = {}, viewerPrefix = '') {
  const framable = (value) => (/^https?:\/\//i.test(value ?? '') ? value : '');

  if (info.linkUrl) return framable(info.linkUrl);

  const page = info.pageUrl || '';
  if (viewerPrefix && page.startsWith(viewerPrefix)) {
    // The frame the click landed in is the most precise answer. Its absence
    // means the click was on the viewer's own furniture, so fall back to the
    // address the viewer records for what it is showing.
    const framed = framable(info.frameUrl);
    if (framed) return framed;
    try {
      return framable(new URL(page).searchParams.get('url'));
    } catch {
      return '';
    }
  }

  return framable(page);
}
