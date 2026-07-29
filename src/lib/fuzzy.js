/**
 * Small fuzzy matcher in the fzy/Sublime style.
 *
 * Characters of the query must appear in order in the target, but not
 * contiguously. Scoring favours matches that start a word ("gs24" -> "Galaxy
 * S24"), runs of consecutive characters, and matches near the front of the
 * string, so "ip15p" ranks "iPhone 15 Pro" above "iPhone 15 Pro Max".
 *
 * Returns { score, indices } or null when the query is not a subsequence.
 */

const SCORE_MATCH = 16;
const BONUS_BOUNDARY = 10; // match starts a word
const BONUS_CAMEL = 6; // lowercase -> uppercase transition
const BONUS_CONSECUTIVE = 12; // directly follows the previous match
const BONUS_FIRST_CHAR = 8; // very first character of the target
const PENALTY_GAP_START = -5;
const PENALTY_GAP_EXTEND = -1;

const isBoundaryChar = (ch) =>
  ch === ' ' || ch === '-' || ch === '_' || ch === '/' || ch === '(' || ch === '"';

/** Per-position bonus for starting a match at each index of `target`. */
function boundaryBonuses(target) {
  const bonuses = new Int32Array(target.length);
  for (let i = 0; i < target.length; i++) {
    const ch = target[i];
    const prev = i > 0 ? target[i - 1] : '';
    if (i === 0) {
      bonuses[i] = BONUS_BOUNDARY + BONUS_FIRST_CHAR;
    } else if (isBoundaryChar(prev)) {
      bonuses[i] = BONUS_BOUNDARY;
    } else if (ch >= 'A' && ch <= 'Z' && prev >= 'a' && prev <= 'z') {
      bonuses[i] = BONUS_CAMEL;
    } else if (ch >= '0' && ch <= '9' && !(prev >= '0' && prev <= '9')) {
      bonuses[i] = BONUS_CAMEL;
    }
  }
  return bonuses;
}

export function fuzzyMatch(query, target) {
  const q = query.trim();
  if (!q) return { score: 0, indices: [] };
  if (q.length > target.length) return null;

  const ql = q.toLowerCase();
  const tl = target.toLowerCase();

  // Cheap reject: must be a subsequence at all.
  let probe = 0;
  for (let i = 0; i < tl.length && probe < ql.length; i++) {
    if (tl[i] === ql[probe]) probe++;
  }
  if (probe < ql.length) return null;

  const n = ql.length;
  const m = tl.length;
  const bonuses = boundaryBonuses(target);

  // D[i][j] - best score for query[0..i] where query[i] is matched at target[j].
  // M[i][j] - best score for query[0..i] using target[0..j], match or not.
  const NEG = -1e9;
  const D = Array.from({ length: n }, () => new Float64Array(m).fill(NEG));
  const M = Array.from({ length: n }, () => new Float64Array(m).fill(NEG));

  for (let i = 0; i < n; i++) {
    let prevM = NEG; // M[i][j-1]
    for (let j = 0; j < m; j++) {
      if (ql[i] === tl[j]) {
        let score = NEG;
        if (i === 0) {
          score = j * PENALTY_GAP_EXTEND + SCORE_MATCH + bonuses[j];
        } else if (j > 0) {
          const fromNewRun = M[i - 1][j - 1] + SCORE_MATCH + bonuses[j];
          const fromConsecutive = D[i - 1][j - 1] + SCORE_MATCH + BONUS_CONSECUTIVE;
          score = Math.max(fromNewRun, fromConsecutive);
        }
        D[i][j] = score;
      }
      const gap =
        prevM === NEG
          ? NEG
          : prevM +
            (j > 0 && D[i][j - 1] === prevM ? PENALTY_GAP_START : PENALTY_GAP_EXTEND);
      M[i][j] = Math.max(D[i][j], gap);
      prevM = M[i][j];
    }
  }

  // Score at the last matched character rather than at end-of-string, so a
  // long name is not penalised for the characters trailing the match. That
  // keeps "iphone" scoring every iPhone equally and lets the caller's tiebreak
  // (newest first) decide the order.
  let score = NEG;
  let end = -1;
  for (let k = n - 1; k < m; k++) {
    if (D[n - 1][k] > score) {
      score = D[n - 1][k];
      end = k;
    }
  }
  if (end < 0) return null;

  // Trace back through D to recover which characters matched.
  const indices = [end];
  let j = end - 1;
  for (let i = n - 2; i >= 0; i--) {
    let best = NEG;
    let bestJ = -1;
    for (let k = j; k >= i; k--) {
      if (D[i][k] > best) {
        best = D[i][k];
        bestJ = k;
      }
    }
    if (bestJ < 0) return null;
    indices.unshift(bestJ);
    j = bestJ - 1;
  }

  return { score, indices };
}

/**
 * Rank `items` against `query`.
 *
 * @param key      maps an item to its searchable text
 * @param tiebreak orders items whose scores are equal
 * @param boost    extra score for an item, e.g. an exact-name bonus. Because
 *                 scoring ignores unmatched trailing characters, "iPhone 15
 *                 Pro" otherwise ties with "iPhone 15 Pro Max"; a boost on
 *                 exact equality settles it without making short names win
 *                 generic queries like "iphone".
 */
export function fuzzyFilter(query, items, key, tiebreak = () => 0, boost = () => 0) {
  if (!query.trim()) return items.map((item) => ({ item, score: 0, indices: [] }));
  const out = [];
  for (const item of items) {
    const hit = fuzzyMatch(query, key(item));
    if (hit) out.push({ item, ...hit, score: hit.score + boost(item, query) });
  }
  out.sort((a, b) => b.score - a.score || tiebreak(a.item, b.item));
  return out;
}

/** Escape for HTML, wrapping matched indices in <mark>. */
export function highlight(text, indices) {
  const set = new Set(indices);
  let html = '';
  let open = false;
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    if (hit && !open) {
      html += '<mark>';
      open = true;
    } else if (!hit && open) {
      html += '</mark>';
      open = false;
    }
    const ch = text[i];
    html += ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch;
  }
  if (open) html += '</mark>';
  return html;
}
