// Eyeball subassembly build steps: `bun tests/e2e/_steps-sub.ts <outdir>` (dev stack running). Opens
// the stage example, adds a carriage subassembly (two copies, one turned) with its own build script,
// and a kit whose build builds the carriage on its own first, then mounts both copies.
import { chromium } from "playwright";
import { virtualAuthenticator, signUp } from "./auth";
const [out] = process.argv.slice(2);
const scripts: Record<string, string> = {
  "studios/carriage.ts": `import { assembly } from "parasocial";
import { carriage, table, screw, bearing } from "./parts";
export default assembly("Carriage", ({ fix, fastened, insert }) => {
  fix(carriage);
  fastened(carriage, table);
  for (let i = 0; i < 4; i++) fastened(table.at("bolt", i), insert(screw, { name: \`bolt \${i + 1}\` }).at("head"));
  fastened(table.at("seat"), bearing.at("back"));
});`,
  "studios/kit.ts": `import { assembly } from "parasocial";
import base, { rail } from "./parts";
import carriage from "./carriage";
export default assembly("Stage kit", ({ fix, fastened, insert }) => {
  fix(base);
  fastened(base, rail);
  insert(carriage, { name: "a", place: { translate: [-40, 0, 0] } });
  insert(carriage, { name: "b", place: { translate: [40, 0, 0], rotate: { axis: "Z", angle: 180 } } });
});`,
  "builds/carriage.ts": `import { buildSteps } from "parasocial";
import carriageAsm from "../studios/carriage";
import { carriage, table, screw, bearing } from "../studios/parts";
export default buildSteps(carriageAsm, ({ step }) => {
  step("Set down the carriage", carriage);
  step("Fit the table", table, { from: [0, 0, 40] });
  step("Screw down the table", screw, { from: [0, 0, 20], turn: 1080, stagger: 0.25 });
  step("Press in the bearing", bearing, { from: [0, 0, 30] });
});`,
  "builds/kit.ts": `import { buildSteps } from "parasocial";
import kit from "../studios/kit";
import carriageAsm from "../studios/carriage";
import base, { rail } from "../studios/parts";
import carriageSteps from "./carriage";
export default buildSteps(kit, ({ step, sub }) => {
  step("Set down the base", base);
  step("Bolt on the rail", rail, { from: [0, 0, 30] });
  step("Mount the carriages", [sub(carriageAsm, "a"), sub(carriageAsm, "b")], { from: [0, 0, 50], stagger: 0.3, build: carriageSteps });
});`,
};
const b = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("console", (m) => m.type() === "error" && console.log("[console]", m.text()));
await virtualAuthenticator(page);
await signUp(page, "Ada Lovelace");
await page.getByTestId("example-stage").dblclick();
await page.waitForURL(/\/d\//);
const ready = () =>
  page.waitForFunction(() => {
    const ws = (globalThis as any).__ws;
    return ws?.kernelReady && Object.keys(ws.results ?? {}).length > 0 && Object.values(ws.regen ?? {}).every((s) => s === "idle");
  }, null, { timeout: 90000 });
await ready();
// the app's own module instance (same URL Vite serves it at)
const sync = new URL("../../packages/sync/src/index.ts", import.meta.url).pathname;
await page.evaluate(
  async ({ scripts, sync }) => {
    const { mutators } = await import(/* @vite-ignore */ `/@fs${sync}`);
    const ws = (globalThis as any).__ws;
    for (const [path, content] of Object.entries(scripts)) await ws.zero.mutate(mutators.script.write({ documentID: ws.documentID, path, content, baseVersion: null, message: `Add ${path}` })).client;
  },
  { scripts, sync },
);
await page.waitForFunction(() => (globalThis as any).__ws.steps.builds.some((b: any) => b.id === "kit"), null, { timeout: 30000 });
await page.evaluate(() => (globalThis as any).__ws.setActiveStudio("studios/kit.ts"));
await ready();
await page.waitForTimeout(1500);
await page.getByTestId("build-steps-button").click();
await page.waitForTimeout(300);
const state = () => page.evaluate(() => { const s = (globalThis as any).__ws.steps; return { n: s.steps.length, titles: s.steps.map((x: any) => `${x.stage ? "  " : ""}${x.title}`), stages: s.build?.stages, problems: s.build?.problems.map((p: any) => p.message) }; });
console.log(JSON.stringify(await state(), null, 1));
await page.keyboard.press("Space");
for (const pos of [1, 2, 2.5, 4.4, 6, 6.4, 7]) {
  await page.evaluate((p) => (globalThis as any).__ws.steps.scrub(p), pos);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/sub-${pos}.png` });
}
await b.close();
