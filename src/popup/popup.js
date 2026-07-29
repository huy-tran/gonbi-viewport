import {
  DEVICES,
  CATEGORIES,
  DEVICE_BY_ID,
  searchText,
  byYearDesc,
  exactNameBoost,
} from '../data/devices.js';
import { fuzzyFilter, highlight } from '../lib/fuzzy.js';
import { renderIcon, hydrateIcons } from '../lib/icon.js';
import {
  getState,
  toggleFavourite,
  pushRecent,
  deleteSet,
  recallSiteDevices,
  hostOf,
} from '../lib/store.js';

const searchEl = document.getElementById('search');
const listEl = document.getElementById('list');
const targetEl = document.getElementById('target');

let state = { favourites: [], recents: [], sets: [] };
let targetUrl = '';
/** Devices last used on this hostname, if any. */
let siteDeviceIds = null;
/** Set when the popup was opened from a viewer tab, so we replace it in place. */
let reuseTabId = null;
/** Flat list of rendered devices, for keyboard navigation. */
let rendered = [];
let activeIndex = 0;

const VIEWER_PREFIX = chrome.runtime.getURL('src/viewer/viewer.html');

async function readActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  if (tab.url?.startsWith(VIEWER_PREFIX)) {
    // Already inside a viewer: keep the site it is showing and swap the device.
    reuseTabId = tab.id;
    targetUrl = new URL(tab.url).searchParams.get('url') || '';
  } else if (/^https?:/.test(tab.url || '')) {
    targetUrl = tab.url;
  }
  targetEl.textContent = targetUrl || 'a blank page';
  siteDeviceIds = targetUrl ? await recallSiteDevices(targetUrl) : null;
}

function meta(device) {
  const dpr = Number.isInteger(device.dpr)
    ? device.dpr
    : device.dpr.toFixed(2).replace(/0+$/, '');
  return `${device.width} × ${device.height} · @${dpr}x`;
}

function rowHtml(device, indices) {
  const label = `${device.brand} ${device.name}`;
  const isFav = state.favourites.includes(device.id);
  return `
    <span class="row__thumb"></span>
    <span class="row__body">
      <span class="row__name">${highlight(label, indices)}</span>
      <span class="row__meta">${meta(device)}</span>
    </span>
    <button class="row__star ${isFav ? 'is-on' : ''}" data-star="${device.id}"
            title="${isFav ? 'Remove from favourites' : 'Add to favourites'}"
            aria-label="${isFav ? 'Remove from favourites' : 'Add to favourites'}">
      ${renderIcon('star', { size: 14, filled: isFav })}
    </button>`;
}

function makeRow(device, indices) {
  const el = document.createElement('div');
  el.className = 'row';
  // Listbox pattern: the search field keeps focus and points at the active
  // option, so arrow keys work without losing the ability to type. Rows are
  // still tab-reachable for anyone navigating without the search box.
  el.setAttribute('role', 'option');
  el.setAttribute('aria-selected', 'false');
  el.id = `device-${device.id}`;
  el.tabIndex = 0;
  el.dataset.id = device.id;
  el.style.setProperty(
    '--thumb',
    `url("${chrome.runtime.getURL(`assets/frames/${device.id}.svg`)}")`,
  );
  el.innerHTML = rowHtml(device, indices);
  return el;
}

/** A saved comparison set: opens every device in it at once. */
function makeSetRow(set) {
  const row = document.createElement('div');
  row.className = 'row row--set';
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', 'false');
  row.tabIndex = 0;
  row.dataset.set = set.name;

  const names = set.deviceIds
    .map((id) => DEVICE_BY_ID.get(id)?.name)
    .filter(Boolean)
    .join(', ');

  row.innerHTML = `
    <span class="row__thumb row__thumb--set">${renderIcon('compare', { size: 18 })}</span>
    <span class="row__body">
      <span class="row__name"></span>
      <span class="row__meta"></span>
    </span>
    <button class="row__star" data-unset="${set.name}" title="Delete this set" aria-label="Delete this set">
      ${renderIcon('close', { size: 13 })}
    </button>`;
  row.querySelector('.row__name').textContent = set.name;
  row.querySelector('.row__meta').textContent =
    `${set.deviceIds.length} devices · ${names}`;
  return row;
}

function section(title, entries) {
  if (!entries.length) return null;
  const frag = document.createDocumentFragment();
  const heading = document.createElement('div');
  heading.className = 'group';
  heading.textContent = title;
  frag.append(heading);
  for (const { item, indices } of entries) {
    frag.append(makeRow(item, indices));
    rendered.push(item);
  }
  return frag;
}

function render() {
  const query = searchEl.value;
  listEl.replaceChildren();
  rendered = [];

  // Sets are only offered on the unfiltered list; a search is for devices.
  if (query.trim()) {
    const hits = fuzzyFilter(query, DEVICES, searchText, byYearDesc, exactNameBoost);
    if (!hits.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = `No device matches “${query}”`;
      listEl.append(empty);
      return;
    }
    listEl.append(
      section(`${hits.length} result${hits.length === 1 ? '' : 's'}`, hits),
    );
  } else {
    // Saved comparison sets open several devices at once.
    if (state.sets.length) {
      const heading = document.createElement('div');
      heading.className = 'group';
      heading.textContent = 'Saved sets';
      listEl.append(heading);
      for (const set of state.sets) listEl.append(makeSetRow(set));
    }

    // What you last tested this exact site with.
    const remembered = (siteDeviceIds ?? [])
      .map((id) => DEVICE_BY_ID.get(id))
      .filter(Boolean)
      .map((item) => ({ item, indices: [] }));
    const siteSection = section(
      `Last used on ${hostOf(targetUrl) ?? 'this site'}`,
      remembered,
    );
    if (siteSection) listEl.append(siteSection);

    const pinned = [...new Set([...state.favourites, ...state.recents])]
      .map((id) => DEVICE_BY_ID.get(id))
      .filter(Boolean)
      .map((item) => ({ item, indices: [] }));
    const pinnedSection = section('Favourites & recent', pinned);
    if (pinnedSection) listEl.append(pinnedSection);

    for (const cat of CATEGORIES) {
      const entries = DEVICES.filter((d) => d.category === cat.id).map((item) => ({
        item,
        indices: [],
      }));
      const el = section(cat.label, entries);
      if (el) listEl.append(el);
    }
  }

  activeIndex = 0;
  paintActive();
}

function paintActive() {
  const rows = [...listEl.querySelectorAll('.row')];
  rows.forEach((row, i) => {
    const on = i === activeIndex;
    row.classList.toggle('is-active', on);
    row.setAttribute('aria-selected', String(on));
  });
  const active = rows[activeIndex];
  active?.scrollIntoView({ block: 'nearest' });
  if (active) searchEl.setAttribute('aria-activedescendant', active.id);
  else searchEl.removeAttribute('aria-activedescendant');
}

async function open(device) {
  await pushRecent(device.id);
  await chrome.runtime.sendMessage({
    type: 'openViewer',
    deviceId: device.id,
    url: targetUrl,
    reuseTabId,
  });
  window.close();
}

/** Open a whole set by handing the viewer a comma-separated device list. */
async function openSet(set) {
  const params = new URLSearchParams({
    devices: set.deviceIds.join(','),
    compare: '1',
  });
  if (targetUrl) params.set('url', targetUrl);
  const url = chrome.runtime.getURL(`src/viewer/viewer.html?${params}`);
  if (reuseTabId != null) await chrome.tabs.update(reuseTabId, { url });
  else await chrome.tabs.create({ url });
  window.close();
}

listEl.addEventListener('click', async (event) => {
  const unset = event.target.closest('[data-unset]');
  if (unset) {
    event.stopPropagation();
    state.sets = await deleteSet(unset.dataset.unset);
    render();
    return;
  }
  const star = event.target.closest('[data-star]');
  if (star) {
    event.stopPropagation();
    state.favourites = await toggleFavourite(star.dataset.star);
    render();
    return;
  }
  const row = event.target.closest('.row');
  if (!row) return;
  if (row.dataset.set) {
    const set = state.sets.find((s) => s.name === row.dataset.set);
    if (set) openSet(set);
    return;
  }
  const device = DEVICE_BY_ID.get(row.dataset.id);
  if (device) open(device);
});

// Tab-focusing a row makes it the active one, so the two navigation styles
// cannot disagree about which device Enter will open.
listEl.addEventListener('focusin', (event) => {
  const row = event.target.closest('.row');
  if (!row) return;
  const index = [...listEl.querySelectorAll('.row')].indexOf(row);
  if (index >= 0 && index !== activeIndex) {
    activeIndex = index;
    paintActive();
  }
});

listEl.addEventListener('keydown', (event) => {
  const row = event.target.closest('.row');
  if (!row) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    if (row.dataset.set) {
      const set = state.sets.find((s) => s.name === row.dataset.set);
      if (set) openSet(set);
      return;
    }
    const device = DEVICE_BY_ID.get(row.dataset.id);
    if (device) open(device);
  }
});

searchEl.addEventListener('input', render);

searchEl.addEventListener('keydown', (event) => {
  const rows = listEl.querySelectorAll('.row');
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    activeIndex = Math.min(activeIndex + 1, rows.length - 1);
    paintActive();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    activeIndex = Math.max(activeIndex - 1, 0);
    paintActive();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const device = rendered[activeIndex];
    if (device) open(device);
  } else if (event.key === 'Escape') {
    if (searchEl.value) {
      event.preventDefault();
      searchEl.value = '';
      render();
    }
  }
});

(async () => {
  hydrateIcons();
  state = await getState();
  await readActiveTab();
  render();
  searchEl.focus();
})();
