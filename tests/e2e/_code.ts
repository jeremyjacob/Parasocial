import { chromium } from "playwright";
import { virtualAuthenticator, signUp } from "./auth";
const out = process.argv[2];
const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message, e.stack?.split("\n").slice(0, 6).join(" | ")));
page.on("console", (m) => m.type() === "error" && !m.text().includes("404") && console.log("[console]", m.text().slice(0, 300)));
await virtualAuthenticator(page);
await signUp(page, "Grace Hopper");
await page.getByTestId("example-bracket").click();
await page.waitForURL(/\/d\//);
await page.waitForFunction(() => (globalThis as any).__ws?.results?.bracket && (globalThis as any).__ws.kernelReady, null, { timeout: 30000 });
await page.keyboard.press("Meta+Backslash");
await page.waitForSelector(".monaco-editor", { timeout: 30000 });
await page.waitForTimeout(800);
// type: change width 40 -> 60
await page.evaluate(() => {
  const ed = (globalThis as any).monaco?.editor;
});
await page.locator(".monaco-editor").click();
await page.keyboard.press("Meta+f");
await page.keyboard.type('"width", 40');
await page.keyboard.press("Escape");
await page.keyboard.press("ArrowRight");
await page.keyboard.press("Backspace"); await page.keyboard.press("Backspace");
await page.keyboard.type("60");
await page.waitForTimeout(1500);
console.log("preview", await page.getByTestId("unsaved-preview").count(), await page.evaluate(() => JSON.stringify({ dirty: (globalThis as any).__ws.dirty, bbox: (globalThis as any).__ws.results.bracket.bbox })));
await page.screenshot({ path: `${out}/code-preview.png` });
await page.keyboard.press("Meta+s");
await page.waitForTimeout(2000);
console.log("saved", await page.evaluate(() => JSON.stringify({ dirty: (globalThis as any).__ws.dirty, versions: (globalThis as any).__ws.versions.map((v: any) => v.message) })));
// break it: syntax error shows a marker, geometry stays
await page.keyboard.type(" ))");
await page.waitForTimeout(1500);
console.log("problems", await page.evaluate(() => JSON.stringify((globalThis as any).__ws.problems.map((p: any) => p.message))));
await page.screenshot({ path: `${out}/code-error.png` });
await b.close();
