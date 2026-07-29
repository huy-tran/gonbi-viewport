import { ICONS } from '../data/icons.js';

/**
 * Hugeicons artwork is stroke-based on a 24x24 grid. `filled` paints the shape
 * as well, which is how the favourite star shows its active state.
 *
 * The markup is generated at build time from a trusted package and contains no
 * user input, so inserting it as HTML is safe.
 */
export function renderIcon(name, { size = 16, filled = false } = {}) {
  const body = ICONS[name];
  if (!body) throw new Error(`unknown icon: ${name}`);
  return (
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" ` +
    `fill="${filled ? 'currentColor' : 'none'}" aria-hidden="true" focusable="false">${body}</svg>`
  );
}

/** Fill every `<x data-icon="name">` in `root` with its icon. */
export function hydrateIcons(root = document) {
  for (const host of root.querySelectorAll('[data-icon]')) {
    const size = Number(host.dataset.iconSize) || 16;
    host.innerHTML = renderIcon(host.dataset.icon, { size });
  }
}
