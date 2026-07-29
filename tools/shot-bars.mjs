/**
 * Visual check for the simulated device bars: opens the viewer on one device per
 * bar treatment and crops a close-up of the top of the screen, so the status bar
 * and the camera the frame draws over it can be compared by eye.
 *
 * Run: node tools/shot-bars.mjs
 */

import puppeteer from 'puppeteer-core';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'tools', 'shots');

function findChrome() {
  const base = path.join(ROOT, 'tools', 'browsers', 'chrome');
  for (const dir of fs.readdirSync(base)) {
    const exe = path.join(base, dir, 'chrome-win64', 'chrome.exe');
    if (fs.existsSync(exe)) return exe;
  }
  throw new Error('Chrome for Testing not found under tools/browsers');
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gonbi-bars-'));
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: false,
  userDataDir,
  protocolTimeout: 120000,
  args: [
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`,
    '--no-first-run',
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--no-default-browser-check',
    '--window-size=1500,1000',
  ],
});

try {
  const sw = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
    { timeout: 20000 },
  );
  const extId = new URL(sw.url()).host;

  for (const id of ['galaxy-s24', 'iphone-15-pro', 'ipad-air-4', 'iphone-se']) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    const url = `chrome-extension://${extId}/src/viewer/viewer.html?devices=${id}&url=${encodeURIComponent('https://example.com/')}`;
    await page.goto(url, { waitUntil: 'networkidle2' });
    await wait(3500);

    // Zoom in so the bar is legible in the crop, then frame the top of the device.
    await page.select('#zoom', '2').catch(() => {});
    await wait(1200);

    const box = await page.$eval('.pane', (n) => {
      const r = n.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    await page.screenshot({
      path: path.join(SHOTS, `bar-${id}.png`),
      clip: {
        x: Math.max(0, Math.round(box.x) - 8),
        y: Math.max(0, Math.round(box.y) - 8),
        width: Math.min(1400, Math.round(box.width) + 16),
        height: Math.min(300, Math.round(box.height)),
      },
    });
    console.log(`wrote tools/shots/bar-${id}.png`);
    await page.close();
  }
} finally {
  await browser.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
