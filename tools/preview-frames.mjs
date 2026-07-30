/** Renders a contact sheet of the generated frames so they can be eyeballed. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(ROOT, 'tools', 'browsers', 'chrome');
const CHROME = fs
  .readdirSync(base)
  .map((d) => path.join(base, d, 'chrome-win64', 'chrome.exe'))
  .find(fs.existsSync);

const picks = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'iphone-15-pro',
      'iphone-se',
      'galaxy-s24',
      'ipad-air-4',
      'ipad-mini',
      'macbook-air-13',
      'imac-24',
      'samsung-tv-55',
      'galaxy-fold',
    ];

const cells = picks
  .map((id) => {
    const file = path.join(ROOT, 'assets', 'frames', `${id}.svg`);
    if (!fs.existsSync(file)) return '';
    const svg = fs.readFileSync(file, 'utf8');
    return `<figure><div class="art">${svg}</div><figcaption>${id}</figcaption></figure>`;
  })
  .join('');

const html = `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;padding:24px;background:#eef1f5;font:12px system-ui;display:flex;flex-wrap:wrap;gap:22px;align-items:flex-end}
  figure{margin:0;text-align:center;color:#333}
  .art{background:
    linear-gradient(45deg,#dfe3ea 25%,transparent 25%,transparent 75%,#dfe3ea 75%),
    linear-gradient(45deg,#dfe3ea 25%,transparent 25%,transparent 75%,#dfe3ea 75%) 8px 8px,#fff;
    background-size:16px 16px;display:inline-block}
  .art svg{height:230px;width:auto;display:block}
  figcaption{margin-top:6px}
</style>${cells}`;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
// Short on purpose: a fullPage shot grows to the content but never shrinks below
// the viewport, so a tall one would pad the sheet with dead space whenever the
// picks happen to fit in fewer rows.
await page.setViewport({ width: 1500, height: 200, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'load' });
await page.screenshot({
  path: path.join(ROOT, 'tools', 'shots', 'frames-preview.png'),
  fullPage: true,
});
await browser.close();
console.log('wrote tools/shots/frames-preview.png');
