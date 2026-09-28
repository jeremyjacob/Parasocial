/**
 * Renders the site's link-preview card, static/og.png (1200×630): the mark, wordmark and tagline
 * over the clay hero art, in the app's own fonts. Rerun after changing the art or the copy
 * (keep the tagline in step with SITE_META in src/lib/server/meta.ts).
 *
 *   bun run scripts/og.ts
 */
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { rm } from 'node:fs/promises';

const root = resolve(import.meta.dir, '..');
const file = (p: string) => `file://${resolve(root, p)}`;
const MARK =
	'M55.3839 9.82878C59.4778 7.46516 64.5223 7.46613 68.6163 9.82976L103.873 30.1852C107.967 32.5489 110.489 36.917 110.489 41.6442V82.3551C110.489 87.0823 107.967 91.4505 103.873 93.8141L68.6163 114.171C64.5223 116.534 59.4778 116.534 55.3839 114.171L20.127 93.8141C16.0332 91.4505 13.5108 87.0824 13.5108 82.3551V41.6442C13.5108 36.917 16.0331 32.5489 20.127 30.1852L55.3839 9.82878ZM65.6143 36.1276C63.3776 34.8363 60.6216 34.8362 58.3848 36.1276L41.4014 45.9333C39.1646 47.2247 37.7862 49.6112 37.7862 52.194V71.8053C37.7862 74.3882 39.1646 76.7747 41.4014 78.0661L58.3848 87.8718C60.6216 89.1631 63.3775 89.1631 65.6143 87.8718L82.5987 78.0661C84.8354 76.7747 86.213 74.3881 86.213 71.8053V52.194C86.2129 49.6112 84.8355 47.2247 82.5987 45.9333L65.6143 36.1276Z';

const html = `<!doctype html><html><head><style>
@font-face { font-family: Montserrat; src: url(${file('node_modules/@fontsource-variable/montserrat/files/montserrat-latin-wght-normal.woff2')}) format('woff2'); font-weight: 100 900; }
@font-face { font-family: Inter; src: url(${file('node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2')}) format('woff2'); font-weight: 100 900; }
* { margin: 0; box-sizing: border-box; }
body { width: 1200px; height: 630px; overflow: hidden; background: #f3f3f5; color: #1b1b1f; font-family: Inter; position: relative; }
.art { position: absolute; right: 8px; top: 70px; width: 780px; height: 477px; background: url(${file('static/art/hero-light.webp')}) center / cover; }
.copy { position: absolute; left: 80px; top: 0; bottom: 0; display: flex; flex-direction: column; justify-content: center; gap: 28px; width: 460px; }
.brand { display: flex; align-items: center; gap: 18px; }
.brand span { font-family: Montserrat; font-weight: 600; font-size: 52px; letter-spacing: -0.02em; }
p { font-size: 28px; line-height: 1.35; color: #5b5b66; letter-spacing: -0.01em; }
</style></head><body>
<div class="art"></div>
<div class="copy">
  <div class="brand">
    <svg viewBox="8 8 108 108" width="60" height="60"><defs><radialGradient id="g" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(62 62) rotate(90) scale(53.9431 48.4893)"><stop offset=".476" stop-color="#1b1b1f" stop-opacity=".7"/><stop offset=".976" stop-color="#1b1b1f"/></radialGradient></defs><path fill-rule="evenodd" fill="url(#g)" d="${MARK}"/></svg>
    <span>Parasocial</span>
  </div>
  <p>Parametric CAD in code. Pin notes on the model and your agent makes the change.</p>
</div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
// from a file, so the page may load the art and fonts (file://)
const tmp = resolve(root, 'scripts/.og.html');
await Bun.write(tmp, html);
await page.goto(`file://${tmp}`, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: resolve(root, 'static/og.png') });
await browser.close();
await rm(tmp);
console.log('wrote static/og.png');
