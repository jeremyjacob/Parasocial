// Eyeball the build animation: `bun tests/e2e/_build.ts <outdir> [example] [parts…]` (dev stack running).
import { chromium } from "playwright";
import { virtualAuthenticator, signUp } from "./auth";
const [out, example = "stage", ...parts] = process.argv.slice(2);
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("console", (m) => m.type() === "error" && console.log("[console]", m.text()));
await virtualAuthenticator(page);
await signUp(page, "Ada Lovelace");
await page.getByTestId(`example-${example}`).dblclick();
await page.waitForURL(/\/d\//);
await page.waitForFunction(
  (ps) => {
    const ws = (globalThis as any).__ws;
    return ws?.kernelReady && Object.keys(ws.results ?? {}).length > 0 && ps.every((p: string) => ws.results?.[p]) && Object.values(ws.regen ?? {}).every((s) => s === "idle");
  },
  parts,
  { timeout: 60000 },
);
await page.waitForTimeout(1500);
await page.keyboard.press("a");
await page.waitForTimeout(100);
// pause and scrub to fixed points
for (const t of [0.15, 0.35, 0.55, 0.75, 1]) {
  await page.evaluate((t) => ((globalThis as any).__ws.build = { t, playing: false, loop: false }), t);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${out}/build-${Math.round(t * 100)}.png` });
}
// and let it play from the start
await page.evaluate(() => ((globalThis as any).__ws.build = { t: 0, playing: true, loop: false }));
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(400);
  console.log("t", await page.evaluate(() => [performance.now() | 0, (globalThis as any).__ws.build?.t, (globalThis as any).__ws.viewer?.buildDuration()]));
}
await page.screenshot({ path: `${out}/build-playing.png` });
console.log("build state", await page.evaluate(() => JSON.stringify((globalThis as any).__ws.build)));
await b.close();
