/** Thin wrapper over chrome.storage.local for the bits of UI state we keep. */

const DEFAULTS = {
  favourites: [],
  recents: [],
  zoom: 'fit', // 'fit' | number (1 = 100%)
  showFrame: true,
  showDeviceUi: true,
  syncScroll: false,
  comparing: false,
  browserId: null,
  lastDeviceId: null,
  /** Named comparison sets: [{ name, deviceIds }]. */
  sets: [],
  /** hostname -> device ids last used there. */
  siteDevices: {},
  /** hostname -> true where the reader asked for their session to be bridged. */
  siteSessions: {},
};

const MAX_RECENTS = 6;
const MAX_SETS = 12;

export async function getState() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

export async function setState(patch) {
  await chrome.storage.local.set(patch);
}

export async function toggleFavourite(deviceId) {
  const { favourites } = await getState();
  const next = favourites.includes(deviceId)
    ? favourites.filter((id) => id !== deviceId)
    : [...favourites, deviceId];
  await setState({ favourites: next });
  return next;
}

export async function pushRecent(deviceId) {
  const { recents } = await getState();
  const next = [deviceId, ...recents.filter((id) => id !== deviceId)].slice(
    0,
    MAX_RECENTS,
  );
  await setState({ recents: next, lastDeviceId: deviceId });
  return next;
}

// ---------------------------------------------------------------- device sets --

export async function saveSet(name, deviceIds) {
  const { sets } = await getState();
  const trimmed = name.trim();
  if (!trimmed || !deviceIds.length) return sets;
  // Re-saving under an existing name replaces it rather than duplicating.
  const next = [
    { name: trimmed, deviceIds },
    ...sets.filter((s) => s.name.toLowerCase() !== trimmed.toLowerCase()),
  ].slice(0, MAX_SETS);
  await setState({ sets: next });
  return next;
}

export async function deleteSet(name) {
  const { sets } = await getState();
  const next = sets.filter((s) => s.name !== name);
  await setState({ sets: next });
  return next;
}

// -------------------------------------------------------------- site memory --

export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Remember which devices were used on a host, so returning to a site brings
 * back the setup you were last testing it with.
 */
export async function rememberSiteDevices(url, deviceIds) {
  const host = hostOf(url);
  if (!host || !deviceIds.length) return;
  const { siteDevices } = await getState();
  await setState({ siteDevices: { ...siteDevices, [host]: deviceIds } });
}

export async function recallSiteDevices(url) {
  const host = hostOf(url);
  if (!host) return null;
  const { siteDevices } = await getState();
  return siteDevices[host] ?? null;
}

/**
 * Which sites the reader has asked to carry their session into.
 *
 * Per host and opt-in on purpose. The bridge hands a site's real cookies to a
 * frame the browser had decided to withhold them from, which is exactly what
 * you want on a staging site you are signed into and not something to do to
 * every site you happen to preview. Turning it off forgets the host outright
 * rather than storing a `false`, so the record is only ever of consent given.
 */
export async function rememberSiteSession(url, on) {
  const host = hostOf(url);
  if (!host) return;
  const { siteSessions } = await getState();
  const next = { ...siteSessions };
  if (on) next[host] = true;
  else delete next[host];
  await setState({ siteSessions: next });
}
