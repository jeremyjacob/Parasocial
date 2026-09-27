// M0 verification in real Chromium: cross-origin engine iframe, COEP, threads, transfer, picking.
import { chromium } from "playwright";
const out = process.argv[2] ?? ".";
const browser = await chromium.launch({ args: ["--enable-features=SharedArrayBuffer", "--use-angle=metal", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on("console", (m) => console.log("[console]", m.type(), m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
async function run(url: string) {
  const t = Date.now();
  await page.goto(url);
  await page.waitForFunction(() => (window as any).__m0?.done, null, { timeout: 60000 });
  const m0 = await page.evaluate(() => (window as any).__m0);
  return { wallMs: Date.now() - t, ...m0 };
}
const cold = await run("http://localhost:5180/?doc=bracket");
console.log("COLD", JSON.stringify({ appIsolated: cold.appIsolated, engine: cold.engine, readyMs: cold.readyMs, regen: cold.regen, stats: cold.stats, warmParamMs: cold.warmParamMs }, null, 1));
await page.screenshot({ path: `${out}/m0-bracket.png` });
// pick at the center: should hit a face
const box = await page.locator("#vp").boundingBox();
await page.mouse.move(box!.x + box!.width * 0.62, box!.y + box!.height * 0.58);
await page.mouse.click(box!.x + box!.width * 0.62, box!.y + box!.height * 0.58);
await page.waitForTimeout(300);
const sel = await page.evaluate(() => ({ s: (window as any).__m0.lastSelect, d: (window as any).__m0.lastDescribe, ms: (window as any).__m0.selectMs, pickMs: (window as any).__viewer.stats.lastPickMs }));
console.log("PICK", JSON.stringify(sel));
await page.screenshot({ path: `${out}/m0-selected.png` });
const warm = await run("http://localhost:5180/?doc=bracket");
console.log("CACHED readyMs", warm.readyMs.toFixed(0), "kernelMs", warm.engine.kernelMs.toFixed(0));
for (const doc of ["knob", "flange", "enclosure"]) {
  const mt = await run(`http://localhost:5180/?doc=${doc}&threads=1`);
  const st = await run(`http://localhost:5180/?doc=${doc}&threads=0`);
  console.log("THREADS", doc, "multi", mt.engine.threads, mt.regen.map((r: any) => r.engineMs.toFixed(0)).join("/"), "ms | single", st.engine.threads, st.regen.map((r: any) => r.engineMs.toFixed(0)).join("/"), "ms");
  await page.screenshot({ path: `${out}/m0-${doc}.png` });
}
await browser.close();
