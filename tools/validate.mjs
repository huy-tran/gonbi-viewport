/**
 * Structural checks before loading the extension unpacked.
 * Run: node tools/validate.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEVICES, CATEGORIES } from '../src/data/devices.js';
import { FRAME_GEOMETRY } from '../src/data/frame-geometry.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const warnings = [];

const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

// --- manifest ---------------------------------------------------------------
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const manifestRefs = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...Object.values(manifest.action.default_icon),
  ...Object.values(manifest.icons),
];
for (const ref of manifestRefs) {
  if (!exists(ref)) problems.push(`manifest references missing file: ${ref}`);
}

/*
 * The release workflow builds its notes from the changelog section matching the
 * manifest version, so a missing section ships a release with a bare commit
 * list. A warning rather than a problem: the version is often bumped first and
 * the entry written before tagging, and that window should not fail the suite.
 */
const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
const version = manifest.version.replace(/\./g, '\\.');
if (!new RegExp(`^## ${version}(\\s|$)`, 'm').test(changelog)) {
  warnings.push(
    `CHANGELOG.md has no "## ${manifest.version}" section - a release tagged now would carry generated notes`,
  );
}

// --- source files referenced by the pages ------------------------------------
for (const rel of [
  'src/popup/popup.html',
  'src/popup/popup.css',
  'src/popup/popup.js',
  'src/viewer/viewer.html',
  'src/viewer/viewer.css',
  'src/viewer/viewer.js',
  'src/lib/fuzzy.js',
  'src/lib/store.js',
  'src/lib/cookies.js',
  'src/lib/icon.js',
  'src/lib/device-chrome.js',
  'src/lib/breakpoints.js',
  'src/inject/emulate.js',
  'src/data/browsers.js',
  'src/data/devices.js',
  'src/data/frame-geometry.js',
  'src/data/icons.js',
  'src/background.js',
]) {
  if (!exists(rel)) problems.push(`missing source file: ${rel}`);
}

// --- icons -------------------------------------------------------------------
const { ICONS } = await import('../src/data/icons.js');
/**
 * Every file that names a concrete icon. Missing one makes the unused-icon
 * check report falsely; including src/lib/icon.js would too, since its own
 * documentation shows a `data-icon="name"` placeholder.
 */
const markup = [
  'src/popup/popup.html',
  'src/popup/popup.js',
  'src/viewer/viewer.html',
  'src/viewer/viewer.js',
  'src/viewer/capture.js',
  'src/viewer/audit-ui.js',
  'src/lib/device-chrome.js',
]
  .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'))
  .join('\n');

const iconUses = new Set([...markup.matchAll(/data-icon="([\w-]+)"/g)].map((m) => m[1]));
/*
 * Every quoted name inside a renderIcon call, not just the first argument:
 * `renderIcon(active ? 'stop' : 'record')` is a real call site, and matching
 * only the leading quote reported "stop" as dead code.
 */
for (const call of markup.matchAll(/renderIcon\(([^)]*)\)/g)) {
  for (const quoted of call[1].matchAll(/'([\w-]+)'/g)) iconUses.add(quoted[1]);
}

for (const name of iconUses) {
  if (!ICONS[name])
    problems.push(`icon "${name}" is used but has no entry in icons.js`);
}

// Dead entries mean the generated module is carrying artwork nothing draws.
for (const name of Object.keys(ICONS)) {
  if (!iconUses.has(name)) {
    warnings.push(`icon "${name}" is generated but never used - drop it from ICON_MAP`);
  }
}
// Nothing should still be hand-drawn inline.
for (const file of ['src/popup/popup.html', 'src/viewer/viewer.html']) {
  if (/<svg/.test(fs.readFileSync(path.join(ROOT, file), 'utf8'))) {
    problems.push(
      `${file} still contains an inline <svg>; icons should come from icons.js`,
    );
  }
}

// --- devices ----------------------------------------------------------------
const ids = new Set();
const categoryIds = new Set(CATEGORIES.map((c) => c.id));

for (const d of DEVICES) {
  if (ids.has(d.id)) problems.push(`duplicate device id: ${d.id}`);
  ids.add(d.id);

  if (!categoryIds.has(d.category))
    problems.push(`${d.id}: unknown category "${d.category}"`);
  if (!d.ua) problems.push(`${d.id}: missing user agent`);
  if (!(d.width > 0 && d.height > 0))
    problems.push(`${d.id}: bad viewport ${d.width}x${d.height}`);

  const art = `assets/frames/${d.id}.svg`;
  if (!exists(art)) problems.push(`${d.id}: missing frame ${art} - run build:frames`);

  const g = FRAME_GEOMETRY[d.id];
  if (!g) {
    problems.push(`${d.id}: no geometry - run build:frames`);
    continue;
  }

  /*
   * The frame is scaled so its cutout is exactly the device viewport, so any
   * aspect mismatch would show as a visibly distorted bezel. Generated frames
   * are drawn from the viewport itself, so this should now be exact - a warning
   * here means the generator and the catalogue have diverged.
   */
  const artAspect = (g.screen.widthPct * g.frame.w) / (g.screen.heightPct * g.frame.h);
  const deviceAspect = d.width / d.height;
  const skew = Math.abs(artAspect / deviceAspect - 1) * 100;
  if (skew > 0.5) {
    warnings.push(
      `${d.id}: frame stretched ${skew.toFixed(2)}% ` +
        `(art ${artAspect.toFixed(3)} vs viewport ${deviceAspect.toFixed(3)})`,
    );
  }
}

// --- unused art --------------------------------------------------------------
const used = new Set(DEVICES.map((d) => d.id));
const onDisk = fs
  .readdirSync(path.join(ROOT, 'assets', 'frames'))
  .filter((f) => f.endsWith('.svg'))
  .map((f) => f.replace(/\.svg$/, ''));
const unused = onDisk.filter((id) => !used.has(id));

// --- report ------------------------------------------------------------------
console.log(
  `devices: ${DEVICES.length}   frames on disk: ${onDisk.length}   unused: ${unused.length}`,
);
if (unused.length) console.log(`  unused: ${unused.join(', ')}`);
if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  ! ${w}`);
}
if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log(`  x ${p}`);
  process.exit(1);
}
console.log('\nno structural problems found');
