/**
 * Produces a real full-page capture and writes small crops of it so the actual
 * pixels can be inspected, rather than trusting the reported dimensions.
 */

import puppeteer from 'puppeteer-core';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tools', 'shots');
const base = path.join(ROOT, 'tools', 'browsers', 'chrome');
const CHROME = fs
  .readdirSync(base)
  .map((d) => path.join(base, d, 'chrome-win64', 'chrome.exe'))
  .find(fs.existsSync);

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gonbi-cap-'));
const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'gonbi-capdl-'));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  userDataDir,
  protocolTimeout: 240000,
  args: [
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`,
    '--no-first-run',
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--window-size=1500,1000',
  ],
});

const sw = await browser.waitForTarget(
  (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
  { timeout: 20000 },
);
const extId = new URL(sw.url()).host;

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
page.on('console', (m) => console.log('[viewer]', m.type(), m.text().slice(0, 160)));
const cdp = await page.createCDPSession();
await cdp.send('Browser.setDownloadBehavior', {
  behavior: 'allow',
  downloadPath: downloads,
  eventsEnabled: false,
});

const SITE = 'https://en.wikipedia.org/wiki/Responsive_web_design';
await page.goto(
  `chrome-extension://${extId}/src/viewer/viewer.html?device=iphone-15-pro&url=${encodeURIComponent(SITE)}`,
  { waitUntil: 'domcontentloaded' },
);
await new Promise((r) => setTimeout(r, 7000));

// Exactly what a shift-click on the toolbar button produces.
const point = await page.$eval('#shot', (node) => {
  const r = node.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.keyboard.down('Shift');
await page.mouse.click(point.x, point.y);
await page.keyboard.up('Shift');

const deadline = Date.now() + 120000;
let file = null;
while (Date.now() < deadline) {
  const found = fs.readdirSync(downloads).filter((f) => f.endsWith('.png'));
  if (found.length) {
    file = found[0];
    // Wait for the write to settle.
    await new Promise((r) => setTimeout(r, 1500));
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.log('status:', await page.$eval('#note', (n) => n.textContent));
console.log('result:', await page.evaluate(() => document.body.dataset.result));
console.log('downloaded:', file);

if (file) {
  const png = PNG.sync.read(fs.readFileSync(path.join(downloads, file)));
  console.log(`image: ${png.width}x${png.height}`);

  // Write three crops: top, middle, bottom.
  const cropAt = (name, y, h) => {
    const height = Math.min(h, png.height - y);
    const out = new PNG({ width: png.width, height });
    PNG.bitblt(png, out, 0, y, png.width, height, 0, 0);
    fs.writeFileSync(path.join(OUT, `capture-${name}.png`), PNG.sync.write(out));
  };
  cropAt('top', 0, 700);
  cropAt('middle', Math.floor(png.height / 2), 700);
  cropAt('bottom', Math.max(0, png.height - 700), 700);

  // How much of the image is a single flat colour, i.e. blank filler.
  let blank = 0;
  for (let i = 0; i < png.width * png.height; i++) {
    const o = i * 4;
    if (png.data[o] === 255 && png.data[o + 1] === 255 && png.data[o + 2] === 255)
      blank++;
  }
  console.log(`pure white: ${((blank / (png.width * png.height)) * 100).toFixed(1)}%`);

  // The same measurement the smoke test makes: bezel slivers show up here.
  const columns = [0, 1, 2, png.width - 3, png.width - 2, png.width - 1];
  let dark = 0;
  for (let y = 0; y < png.height; y++) {
    for (const x of columns) {
      const o = (y * png.width + x) * 4;
      if ((png.data[o] + png.data[o + 1] + png.data[o + 2]) / 3 < 90) dark++;
    }
  }
  console.log(
    `dark outer columns: ${((dark / (png.height * columns.length)) * 100).toFixed(2)}%`,
  );
}

await browser.close();
fs.rmSync(userDataDir, { recursive: true, force: true });
console.log('crops written to tools/shots/capture-*.png');
