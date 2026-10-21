// Eyeball the Build view: `bun tests/e2e/_steps.ts <outdir> [example] [studio]` (dev stack running).
import { chromium } from "playwright";
import { virtualAuthenticator, signUp } from "./auth";
const [out, example = "stage", studio = "studios/stage.ts"] = process.argv.slice(2);
const b = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("console", (m) => m.type() === "error" && console.log("[console]", m.text()));
await virtualAuthenticator(page);
await signUp(page, "Ada Lovelace");
await page.getByTestId(`example-${example}`).dblclick();
await page.waitForURL(/\/d\//);
await page.waitForFunction(() => {
  const ws = (globalThis as any).__ws;
  return ws?.kernelReady && Object.keys(ws.results ?? {}).length > 0 && Object.values(ws.regen ?? {}).every((s) => s === "idle");
}, null, { timeout: 90000 });
await page.evaluate((f) => (globalThis as any).__ws.setActiveStudio(f), studio);
await page.waitForTimeout(1500);
await page.getByTestId("build-steps-button").click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/steps-start.png` });
const ws = () => page.evaluate(() => { const s = (globalThis as any).__ws.steps; return { n: s.steps.length, at: s.at, pos: +s.pos.toFixed(2), playing: s.playing, thumbs: s.thumbs.filter(Boolean).length, problems: s.build?.problems.map((p: any) => p.message) }; });
for (let i = 0; i < 5; i++) {
  await page.waitForTimeout(700);
  console.log(await ws());
  await page.screenshot({ path: `${out}/steps-play-${i}.png` });
}
// pause, then step with the keyboard
await page.keyboard.press("Space");
await page.evaluate(() => (globalThis as any).__ws.steps.go(2));
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/steps-2.png` });
// mid-step
await page.evaluate(() => (globalThis as any).__ws.steps.scrub(2.45));
await page.waitForTimeout(200);
await page.screenshot({ path: `${out}/steps-mid.png` });
await page.keyboard.press("ArrowRight");
await page.waitForTimeout(1600);
console.log(await ws());
await page.screenshot({ path: `${out}/steps-next.png` });
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
console.log("closed", await page.evaluate(() => (globalThis as any).__ws.steps.active));
await page.screenshot({ path: `${out}/steps-closed.png` });
await b.close();
