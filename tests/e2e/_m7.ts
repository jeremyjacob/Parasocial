import { chromium } from "playwright";
import { virtualAuthenticator, signUp } from "./auth";
const out = process.argv[2];
const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await virtualAuthenticator(page);
await signUp(page, "Radia Perlman");
await page.getByTestId("example-bracket").dblclick();
await page.waitForURL(/\/d\//);
await page.waitForFunction(() => (globalThis as any).__ws?.results?.bracket && (globalThis as any).__ws.kernelReady, null, { timeout: 30000 });
await page.waitForTimeout(700);
const vp = (await page.getByTestId("viewport").boundingBox())!;
const P = (fx: number, fy: number) => [vp.x + vp.width * fx, vp.y + vp.height * fy] as const;
// crossing box (right to left) over the middle
let [x0, y0] = P(0.7, 0.35), [x1, y1] = P(0.3, 0.7);
await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move(x1, y1, { steps: 8 });
await page.screenshot({ path: `${out}/box.png` });
await page.mouse.up();
console.log("crossing", await page.evaluate(() => (globalThis as any).__ws.selection.length));
// window box around everything
[x0, y0] = P(0.05, 0.05); [x1, y1] = P(0.95, 0.95);
await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move(x1, y1, { steps: 8 }); await page.mouse.up();
console.log("window", await page.evaluate(() => { const s = (globalThis as any).__ws.selection; return JSON.stringify({ n: s.length, faces: s.filter((r: any) => r.kind === "face").length, edges: s.filter((r: any) => r.kind === "edge").length }); }));
// Tab cycling over the top face
await page.keyboard.press("Escape");
const [tx, ty] = P(0.62, 0.55);
await page.mouse.move(tx, ty);
await page.keyboard.press("Tab"); const a = await page.evaluate(() => JSON.stringify((globalThis as any).__ws.hover));
await page.keyboard.press("Tab"); const bb = await page.evaluate(() => JSON.stringify((globalThis as any).__ws.hover));
console.log("tab", a, bb);
await b.close();
