/**
 * Generates the extension icons: the Hugeicons phone glyph in white on a blue
 * rounded tile. Rasterised by Chrome so the SVG is rendered by the same engine
 * that will display it.
 *
 * Small sizes need optically heavier strokes, so stroke-width is set per size
 * rather than left to scale proportionally.
 *
 * Run: node tools/build-icons.mjs
 */

import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICONS } from '../src/data/icons.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'assets', 'icons');

/** size -> stroke width in the 24x24 grid, before the glyph scale is applied. */
const SIZES = { 16: 3.1, 32: 2.5, 48: 2.2, 128: 1.9 };

/** Glyph scale inside the tile, leaving a comfortable margin. */
const GLYPH_SCALE = 0.66;

function findChrome() {
  const base = path.join(ROOT, 'tools', 'browsers', 'chrome');
  if (fs.existsSync(base)) {
    for (const dir of fs.readdirSync(base)) {
      const exe = path.join(base, dir, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  const stable = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  if (fs.existsSync(stable)) return stable;
  throw new Error('no Chrome found');
}

const page$ = (size, strokeWidth) => `<!doctype html>
<style>
  html, body { margin: 0; background: transparent; }
  svg { display: block; }
  /* CSS beats the stroke-width presentation attribute baked into the paths. */
  #glyph path { stroke: #fff; stroke-width: ${strokeWidth}; fill: none; }
</style>
<svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#5b9dff"/>
      <stop offset="1" stop-color="#2563eb"/>
    </linearGradient>
  </defs>
  <rect width="24" height="24" rx="5.4" fill="url(#tile)"/>
  <g id="glyph" transform="translate(12 12) scale(${GLYPH_SCALE}) translate(-12 -12)">
    ${ICONS.device}
  </g>
</svg>`;

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gonbi-icons-'));
const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  userDataDir,
  args: ['--no-first-run', '--no-default-browser-check'],
});

try {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const page = await browser.newPage();

  for (const [size, strokeWidth] of Object.entries(SIZES)) {
    const px = Number(size);
    await page.setViewport({ width: px, height: px, deviceScaleFactor: 1 });
    await page.setContent(page$(px, strokeWidth), { waitUntil: 'load' });
    await page.screenshot({
      path: path.join(OUT_DIR, `icon-${px}.png`),
      omitBackground: true,
      clip: { x: 0, y: 0, width: px, height: px },
    });
  }
  console.log(
    `wrote ${Object.keys(SIZES)
      .map((s) => `icon-${s}.png`)
      .join(', ')}`,
  );
} finally {
  await browser.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
