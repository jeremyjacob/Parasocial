import { chromium } from "playwright";
import { virtualAuthenticator, signUp } from "./auth";
const out = process.argv[2], ex = process.argv[3] ?? "flange";
const b = await chromium.launch({ args: ["--use-angle=metal", "--ignore-gpu-blocklist"] });
const page = await (await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("console", (m) => m.type() === "error" && !m.text().includes("404") && console.log("[console]", m.text().slice(0, 200)));
await virtualAuthenticator(page);
await signUp(page, "Tester");
await page.getByTestId(`example-${ex}`).dblclick();
await page.waitForURL(/\/d\//);
await page.waitForFunction(() => (globalThis as any).__ws?.kernelReady && Object.keys((globalThis as any).__ws.results).length, null, { timeout: 30000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/look-${ex}.png` });
if (process.argv[4] === "dark") { await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark")); await page.evaluate(() => { localStorage.setItem("parasocial:theme", "dark"); }); await page.reload(); await page.waitForFunction(() => (globalThis as any).__ws?.kernelReady && Object.keys((globalThis as any).__ws.results).length, null, { timeout: 30000 }); await page.waitForTimeout(1500); await page.screenshot({ path: `${out}/look-${ex}-dark.png` }); }
await b.close();
