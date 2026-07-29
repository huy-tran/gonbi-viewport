/**
 * Turns a page's `@media` condition texts into the width breakpoints it
 * actually uses.
 *
 * The injected script cannot import anything - it is serialised into the page -
 * so it only collects raw condition strings. All the parsing lives here, where
 * it can be unit tested.
 */

/** Assumed root font size when a query is written in em or rem. */
const ROOT_FONT_PX = 16;

/**
 * A CSS length in px, or null if it is not a length we can resolve.
 * Only absolute-ish units appear in width queries in practice.
 */
export function parseLength(raw) {
  const text = String(raw).trim().toLowerCase();
  const match = /^(-?[\d.]+)(px|em|rem|pt|pc|in|cm|mm|q)?$/.exec(text);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;

  switch (match[2]) {
    case undefined:
    case 'px':
      return value;
    case 'em':
    case 'rem':
      return value * ROOT_FONT_PX;
    case 'pt':
      return (value * 96) / 72;
    case 'pc':
      return value * 16;
    case 'in':
      return value * 96;
    case 'cm':
      return (value * 96) / 2.54;
    case 'mm':
      return (value * 96) / 25.4;
    case 'q':
      return (value * 96) / 101.6;
    default:
      return null;
  }
}

/**
 * Width constraints in one condition text.
 *
 * Handles the classic form - `(min-width: 768px)` - and the range syntax that
 * replaced it: `(width >= 768px)`, `(768px <= width < 1024px)`.
 */
export function extractWidths(conditionText) {
  const text = String(conditionText || '').toLowerCase();
  const found = [];

  // (min-width: 768px) / (max-width: 767.98px)
  for (const m of text.matchAll(/\(\s*(min|max)-width\s*:\s*([^)]+?)\s*\)/g)) {
    const px = parseLength(m[2]);
    if (px !== null) found.push({ type: m[1], px });
  }

  // (width >= 768px), (width < 1024px) and the reversed operand order.
  for (const m of text.matchAll(/\(\s*width\s*(<=|>=|<|>)\s*([^)\s]+)\s*\)/g)) {
    const px = parseLength(m[2]);
    if (px === null) continue;
    found.push({ type: m[1].startsWith('>') ? 'min' : 'max', px });
  }
  for (const m of text.matchAll(
    /\(\s*([\d.]+(?:px|r?em|pt|pc|in|cm|mm|q)?)\s*(<=|>=|<|>)\s*width/g,
  )) {
    const px = parseLength(m[1]);
    if (px === null) continue;
    // `768px <= width` is a minimum.
    found.push({ type: m[2].startsWith('<') ? 'min' : 'max', px });
  }

  // Interval form: (768px <= width < 1024px) also yields the upper bound.
  for (const m of text.matchAll(
    /\([^)]*?width\s*(<=|<)\s*([\d.]+(?:px|r?em|pt|pc|in|cm|mm|q)?)\s*\)/g,
  )) {
    const px = parseLength(m[2]);
    if (px !== null) found.push({ type: 'max', px });
  }

  // The patterns above deliberately overlap - `(width < 1024px)` is matched by
  // both the range and interval forms - so identical constraints are collapsed.
  const seen = new Set();
  return found.filter(({ type, px }) => {
    const key = `${type}:${px}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Distinct breakpoint widths across every condition text, sorted ascending.
 *
 * A `max-width: 767px` boundary is reported as 768 - the width at which the
 * layout changes - so both spellings of the same breakpoint collapse together
 * instead of showing up as 767 and 768.
 */
export function parseBreakpoints(conditionTexts) {
  const values = new Set();
  for (const text of conditionTexts ?? []) {
    for (const { type, px } of extractWidths(text)) {
      if (px <= 0) continue;
      values.add(type === 'max' ? Math.round(px) + 1 : Math.round(px));
    }
  }
  return [...values].sort((a, b) => a - b);
}

/**
 * The band `width` currently sits in. `from` is inclusive, `to` exclusive and
 * null when open-ended.
 */
export function activeRange(breakpoints, width) {
  let from = 0;
  let to = null;
  for (const bp of breakpoints) {
    if (bp <= width) from = bp;
    else {
      to = bp;
      break;
    }
  }
  return { from, to };
}

export function describeRange({ from, to }) {
  if (!to) return `${from}px and up`;
  if (!from) return `up to ${to - 1}px`;
  return `${from}-${to - 1}px`;
}
