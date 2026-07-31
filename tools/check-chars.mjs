/**
 * Character hygiene for the shipped source.
 *
 * Reports non-ASCII characters so intentional ones stay visible and accidents
 * stand out, and fails on characters that should never be there: C0 control
 * codes (other than tab and newline), replacement characters, and en/em dashes.
 *
 * Pass --fix to strip the control characters.
 *
 * A stray U+001C once survived here because the audit only looked at code points
 * above 127, and it rendered as a blank box in the UI. Hence the low range too.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = process.argv.includes('--fix');

const FILES = [
  'src/lib/breakpoints.js',
  'src/lib/device-chrome.js',
  'src/lib/icon.js',
  'src/lib/store.js',
  'src/lib/cookies.js',
  'src/lib/fuzzy.js',
  'src/data/browsers.js',
  'src/data/devices.js',
  'src/inject/emulate.js',
  'src/background.js',
  'src/popup/popup.html',
  'src/popup/popup.css',
  'src/popup/popup.js',
  'src/viewer/viewer.html',
  'src/viewer/viewer.css',
  'src/viewer/viewer.js',
  'manifest.json',
  'README.md',
  'CHANGELOG.md',
  'tools/test-units.mjs',
  'tools/test-fuzzy.mjs',
  'tools/smoke.mjs',
  'tools/validate.mjs',
  'tools/build-frames.mjs',
  'tools/build-hugeicons.mjs',
  'tools/build-icons.mjs',
];

/** Never legitimate in this source. */
const isForbidden = (code) =>
  (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
  code === 0x7f ||
  code === 0xfffd || // replacement character
  code === 0x2013 || // en dash
  code === 0x2014; // em dash

const inventory = new Map();
const problems = [];

const stripControls = (text) =>
  [...text]
    .filter((ch) => {
      const code = ch.codePointAt(0);
      return (
        !(code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) &&
        code !== 0x7f
      );
    })
    .join('');

// Fix first, so the report below describes the files as they now stand.
if (FIX) {
  for (const rel of FILES) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const cleaned = stripControls(text);
    if (cleaned !== text) {
      fs.writeFileSync(file, cleaned, 'utf8');
      console.log(`stripped control characters from ${rel}`);
    }
  }
  console.log('');
}

for (const rel of FILES) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');

  let line = 1;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (ch === '\n') line++;
    if (isForbidden(code)) {
      problems.push(
        `${rel}:${line}: forbidden U+${code.toString(16).toUpperCase().padStart(4, '0')}`,
      );
    } else if (code > 127) {
      const key = `U+${code.toString(16).toUpperCase().padStart(4, '0')} ${ch}`;
      if (!inventory.has(key)) inventory.set(key, new Set());
      inventory.get(key).add(rel);
    }
  }
}

console.log('non-ASCII in use:');
for (const [key, files] of [...inventory.entries()].sort()) {
  console.log(
    `  ${key.padEnd(12)} ${files.size} file(s): ${[...files].slice(0, 3).join(', ')}`,
  );
}

if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log(`  x ${p}`);
  process.exit(FIX ? 0 : 1);
}
console.log('\nno forbidden characters');
