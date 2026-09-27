import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

// Viewer navigation from wheel input: notched wheels zoom, trackpads orbit/pan with two fingers and
// zoom with a pinch, momentum doesn't coast an orbit, and overlays pass gestures through.
const viewerRoot = fileURLToPath(new URL("../../packages/viewer/", import.meta.url));

async function setup(page: Page) {
  await page.route("**/__trackpad_test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<div id="root" style="position:relative;width:800px;height:600px">
        <div id="viewport" style="position:absolute;inset:0"></div>
        <div id="chip" style="position:absolute;left:10px;top:10px;width:120px;height:40px"></div>
        <div id="list" style="position:absolute;left:10px;top:400px;width:120px;height:100px;overflow:auto"><div style="height:500px"></div></div>
      </div>`,
    }),
  );
  await page.goto("/__trackpad_test");
  await page.evaluate(async (root) => {
    const { Viewer } = await import(/* @vite-ignore */ `/@fs/${root}src/viewer.ts`);
    const THREE = await import(/* @vite-ignore */ "/node_modules/.vite/deps/three.js");
    const viewer = new Viewer(document.getElementById("viewport")!, { viewCube: false, maxDpr: 1, reducedMotion: true });
    const box = new THREE.BoxGeometry(80, 60, 40);
    viewer.setPart({
      id: "box",
      color: "#9ab8e8",
      faceEdges: box.groups.map(() => []),
      mesh: {
        positions: box.attributes.position.array,
        normals: box.attributes.normal.array,
        indices: new Uint32Array(box.index.array),
        faceRanges: new Uint32Array(box.groups.flatMap((g: { start: number; count: number }) => [g.start, g.count])),
        edgePositions: new Float32Array(),
        edgeRanges: new Uint32Array(),
      },
    });
    viewer.listenOn(document.getElementById("root")!);
    const w = window as any;
    w.viewer = viewer;
    w.reset = () => viewer.setCameraState({ position: [200, -260, 180], target: [0, 0, 0], up: [0, 0, 1], ortho: false }, false);
    w.cam = () => {
      const s = viewer.cameraState();
      const d = s.position.map((p: number, i: number) => s.target[i] - p);
      const len = Math.hypot(...d);
      return { dir: d.map((v: number) => v / len), dist: len, target: s.target };
    };
    /** A trackpad-shaped wheel event: pixel deltas with the legacy wheelDelta at −3×delta. */
    w.pad = (el: Element, dx: number, dy: number, mods: { shiftKey?: boolean; ctrlKey?: boolean } = {}) => {
      const r = el.getBoundingClientRect();
      const e = new WheelEvent("wheel", { deltaX: dx, deltaY: dy, deltaMode: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true, ...mods });
      Object.defineProperty(e, "wheelDeltaX", { value: -3 * dx });
      Object.defineProperty(e, "wheelDeltaY", { value: -3 * dy });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    };
    w.reset();
  }, viewerRoot);
}

const angle = (a: number[], b: number[]) => Math.acos(Math.min(1, a.reduce((s, v, i) => s + v * b[i], 0)));

test("a notched mouse wheel zooms toward the cursor", async ({ page }) => {
  await setup(page);
  const before = await page.evaluate(() => (window as any).cam());
  await page.mouse.move(400, 300);
  await page.mouse.wheel(0, -100);
  await expect.poll(() => page.evaluate(() => (window as any).cam().dist)).toBeLessThan(before.dist * 0.95);
  const after = await page.evaluate(() => (window as any).cam());
  expect(angle(before.dir, after.dir)).toBeLessThan(1e-6);
});

test("two-finger scroll orbits, shift pans, and the preference swaps them", async ({ page }) => {
  await setup(page);
  const r = await page.evaluate(() => {
    const w = window as any;
    const canvas = w.viewer.canvas;
    const b = w.cam();
    for (let i = 0; i < 10; i++) w.pad(canvas, -12, 3);
    const orbited = w.cam();
    w.reset();
    for (let i = 0; i < 10; i++) w.pad(canvas, -12, 0, { shiftKey: true });
    const panned = w.cam();
    w.reset();
    w.viewer.setTrackpadScroll("pan");
    for (let i = 0; i < 10; i++) w.pad(canvas, -12, 0);
    const panned2 = w.cam();
    return { b, orbited, panned, panned2 };
  });
  expect(angle(r.b.dir, r.orbited.dir)).toBeGreaterThan(0.3);
  for (const p of [r.panned, r.panned2]) {
    expect(angle(r.b.dir, p.dir)).toBeLessThan(1e-6);
    expect(Math.hypot(...p.target)).toBeGreaterThan(10);
  }
});

test("a pinch zooms 1:1 with the fingers", async ({ page }) => {
  await setup(page);
  const before = await page.evaluate(() => (window as any).cam().dist);
  const cdp = await page.context().newCDPSession(page);
  // over empty space so the zoom focus sits at the target's depth
  await cdp.send("Input.synthesizePinchGesture", { x: 700, y: 80, scaleFactor: 2, relativeSpeed: 400, gestureSourceType: "mouse" });
  const after = await page.evaluate(() => (window as any).cam().dist);
  expect(after / before).toBeGreaterThan(0.4);
  expect(after / before).toBeLessThan(0.6);
});

test("momentum after a flick brakes an orbit and glides out; slowing down by hand still orbits", async ({ page }) => {
  await setup(page);
  const r = await page.evaluate(() => {
    const w = window as any;
    const canvas = w.viewer.canvas;
    for (let i = 0; i < 8; i++) w.pad(canvas, -40, 0);
    // the fingers lift: a smooth geometric decay
    const mid = w.cam().dir;
    for (let i = 1; i < 30; i++) w.pad(canvas, -Math.round(40 * 0.9 ** i), 0);
    const coasted = angle(mid, w.cam().dir);
    w.reset();
    // macOS momentum proper: a slow ~4% decay per event from the release speed
    for (let i = 0; i < 8; i++) w.pad(canvas, -40, 0);
    const mid2 = w.cam().dir;
    let late: number[] = [];
    for (let i = 1; i < 80; i++) {
      w.pad(canvas, -Math.round(40 * 0.96 ** i), 0);
      if (i === 20) late = w.cam().dir;
    }
    const coastedSlow = angle(mid2, w.cam().dir);
    const glide = angle(late, w.cam().dir);
    w.reset();
    // a hand slowing down wobbles in size and direction
    const wobble = [30, 26, 27, 21, 22, 16, 17, 12, 13, 9, 10, 7, 8, 5, 6];
    const start = w.cam().dir;
    for (const [i, m] of wobble.entries()) w.pad(canvas, -m, i % 2 ? 2 : -1);
    return { coasted, coastedSlow, glide, byHand: angle(start, w.cam().dir) };
    function angle(a: number[], b: number[]) {
      return Math.acos(Math.min(1, a.reduce((s, v, i) => s + v * b[i], 0)));
    }
  });
  // at most the first few momentum events land before the decay is recognized
  console.log(r);
  expect(r.coasted).toBeLessThan(0.2);
  expect(r.coastedSlow).toBeLessThan(0.25);
  // it glides out along the tail rather than stopping dead
  expect(r.glide).toBeGreaterThan(0.002);
  expect(r.glide).toBeLessThan(0.05);
  // undamped this wobble orbits 1.49 rad; its decreasing steps are damped a little
  expect(r.byHand).toBeGreaterThan(1.15);
});

test("gestures over overlays navigate; scrollable overlays keep their scroll", async ({ page }) => {
  await setup(page);
  const r = await page.evaluate(() => {
    const w = window as any;
    const b = w.cam();
    const chipTaken = w.pad(document.getElementById("chip")!, 0, -4, { ctrlKey: true });
    const zoomed = w.cam().dist < b.dist;
    const listTaken = w.pad(document.getElementById("list")!, 0, 20);
    return { chipTaken, zoomed, listTaken };
  });
  expect(r).toEqual({ chipTaken: true, zoomed: true, listTaken: false });
});
