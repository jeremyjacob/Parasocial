/**
 * Screenshot /design with Playwright's cached Chromium (1440×900 @2x).
 *
 *   bun run scripts/screens.ts [outDir] [--base=http://localhost:5391] [--sections=a,b]
 *
 * Produces:
 *   split-top.png              first screen of the side-by-side view
 *   {light,dark}-<section>.png each showcase section in a single-theme pane
 *   workspace-{light,dark}.png the composed workspace preview
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const outDir = resolve(args.find((a) => !a.startsWith('--')) ?? 'design-screens');
const base = args.find((a) => a.startsWith('--base='))?.slice(7) ?? 'http://localhost:5391';
const only = args.find((a) => a.startsWith('--sections='))?.slice(11).split(',');
mkdirSync(outDir, { recursive: true });

const sections = only ?? [
	'color',
	'parts',
	'type',
	'spacing',
	'elevation',
	'controls',
	'overlays',
	'display',
	'panels',
	'viewport',
	'states',
	'notes',
	'topbar'
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
page.on('console', (m) => m.type() === 'error' && console.error('[console]', m.text()));

async function settle() {
	await page.evaluate(() => document.fonts.ready);
	await page.waitForTimeout(400);
}

// 1. Split view, first screen.
await page.goto(`${base}/design`, { waitUntil: 'networkidle' });
await settle();
await page.screenshot({ path: join(outDir, 'split-top.png') });
console.log('split-top.png');

// 2. Per-theme sections.
for (const theme of ['light', 'dark'] as const) {
	await page.goto(`${base}/design?view=${theme}`, { waitUntil: 'networkidle' });
	// The sticky header would otherwise overlap element screenshots.
	await page.addStyleTag({ content: '[data-design-header]{position:relative!important}' });
	await settle();
	for (const s of sections) {
		const el = page.locator(`[data-theme="${theme}"] [data-section="${s}"]`).first();
		if (!(await el.count())) continue;
		await el.scrollIntoViewIfNeeded();
		await page.waitForTimeout(150);
		await el.screenshot({ path: join(outDir, `${theme}-${s}.png`) });
		console.log(`${theme}-${s}.png`);
	}
	const ws = page.locator(`[data-workspace="${theme}"]`);
	await ws.scrollIntoViewIfNeeded();
	await page.waitForTimeout(250);
	await ws.screenshot({ path: join(outDir, `workspace-${theme}.png`) });
	console.log(`workspace-${theme}.png`);
}

await browser.close();
