// Eyeball "Create build steps": `bun tests/e2e/_steps-create.ts <outdir> [example] [studio]` (dev stack running).
import { chromium } from "playwright";
import { virtualAuthenticator, signUp } from "./auth";
const [out, example = "lamp", studio = "studios/mechanism.ts"] = process.argv.slice(2);
const b = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await virtualAuthenticator(page);
await signUp(page, "Ada Lovelace");
await page.getByTestId(`example-${example}`).dblclick();
await page.waitForURL(/\/d\//);
await page.waitForFunction(() => {
  const ws = (globalThis as any).__ws;
  return ws?.kernelReady && Object.keys(ws.results ?? {}).length > 0 && Object.values(ws.regen ?? {}).every((s) => s === "idle");
}, null, { timeout: 90000 });
await page.evaluate((f) => (globalThis as any).__ws.setActiveStudio(f), studio);
await page.waitForTimeout(1000);
// pretend the document has no build script yet
await page.evaluate(() => ((globalThis as any).__ws.steps.builds = []));
await page.keyboard.press("a");
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/create-empty.png` });
await page.getByTestId("create-build-steps").click();
await page.waitForFunction(() => (globalThis as any).__ws.steps.steps.length > 0, null, { timeout: 20000 });
await page.waitForTimeout(3500);
const st = await page.evaluate(() => { const s = (globalThis as any).__ws.steps; return { build: s.build?.id, options: s.options.map((o: any) => o.id), titles: s.steps.map((x: any) => x.title), problems: s.build?.problems }; });
console.log(JSON.stringify(st, null, 1));
console.log(await page.evaluate(() => (globalThis as any).__ws.scripts.find((s: any) => s.path === "builds/mechanism.ts" || s.path.startsWith("builds/mechanism"))?.content));
await page.screenshot({ path: `${out}/create-playing.png` });
await b.close();
