// Renders the empty-state clay art (light + dark, AVIF + WebP) into packages/app/static/art.
// Needs the spike servers: `cd packages/viewer && bun spike/serve.ts`.
import { chromium } from "playwright";
import sharp from "sharp";
import { join } from "node:path";

const out = join(import.meta.dir, "../packages/app/static/art");
const scenes: Record<string, { w: number; h: number; items: any[]; view?: number[]; zoom?: number }> = {
  hero: {
    w: 1800, h: 1100, zoom: 0.62,
    items: [
      { doc: "flange", part: "flange", at: [0, 0, 0] },
      { doc: "enclosure", part: "enclosure", at: [-105, 45, 0], rotZ: 0.2 },
      { doc: "knob", part: "knob", at: [80, 50, 0] },
      { doc: "bracket", part: "bracket", at: [72, -58, 0], rotZ: 0.55 },
      { doc: "gasket", part: "gasket", at: [-62, -70, 0], rotZ: -0.3 },
    ],
  },
  thumb: { w: 640, h: 380, items: [{ doc: "flange", part: "flange" }], zoom: 0.62 },
  bracket: { w: 480, h: 260, zoom: 0.62, items: [{ doc: "bracket", part: "bracket", rotZ: 0.3 }] },
  flange: { w: 480, h: 260, zoom: 0.62, items: [{ doc: "flange", part: "flange" }] },
  // Taller parts need more camera distance to fit the shallow preview frame.
  enclosure: { w: 480, h: 260, zoom: 0.85, items: [{ doc: "enclosure", part: "enclosure", rotZ: 0.2 }] },
  knob: { w: 480, h: 260, zoom: 0.85, items: [{ doc: "knob", part: "knob" }] },
  gasket: { w: 480, h: 260, zoom: 0.62, items: [{ doc: "gasket", part: "gasket", rotZ: 0.2 }] },
};

const b = await chromium.launch({ args: ["--use-angle=metal", "--ignore-gpu-blocklist"] });
const page = await b.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto("http://localhost:5180/art.html");
await page.waitForFunction(() => (window as any).artReady);
for (const [name, s] of Object.entries(scenes)) {
  for (const dark of [false, true]) {
    const url: string = await page.evaluate(([items, o]) => (window as any).renderArt(items, o), [s.items, { width: s.w * 2, height: s.h * 2, dark, view: s.view, zoom: s.zoom }] as const);
    const png = Buffer.from(url.split(",")[1], "base64");
    const base = join(out, `${name}-${dark ? "dark" : "light"}`);
    await sharp(png).webp({ quality: 82, alphaQuality: 90 }).toFile(`${base}.webp`);
    await sharp(png).avif({ quality: 55 }).toFile(`${base}.avif`);
    console.log("wrote", base);
  }
}
await b.close();
