import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

// Viewer navigation from wheel input: notched wheels zoom, trackpads orbit/pan with two fingers and
// zoom with a pinch, momentum glides an orbit out briefly, and overlays pass gestures through.
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
    /** A trackpad-shaped wheel event: pixel deltas with the legacy wheelDelta at −3×delta, one per 60 Hz frame. */
    let clock = performance.now();
    w.pad = (el: Element, dx: number, dy: number, mods: { shiftKey?: boolean; ctrlKey?: boolean } = {}) => {
      const r = el.getBoundingClientRect();
      const e = new WheelEvent("wheel", { deltaX: dx, deltaY: dy, deltaMode: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true, ...mods });
      Object.defineProperty(e, "wheelDeltaX", { value: -3 * dx });
      Object.defineProperty(e, "wheelDeltaY", { value: -3 * dy });
      Object.defineProperty(e, "timeStamp", { value: (clock += 1000 / 60) });
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

test("momentum after a flick glides out without a brake; slowing down by hand still orbits", async ({ page }) => {
  await setup(page);
  const r = await page.evaluate(() => {
    const w = window as any;
    const canvas = w.viewer.canvas;
    const steps = (decay: number) => {
      w.reset();
      for (let i = 0; i < 8; i++) w.pad(canvas, -40, 0);
      const out: number[] = [];
      let prev = w.cam().dir;
      for (let i = 1; i < 80; i++) {
        w.pad(canvas, -Math.round(40 * decay ** i), 0);
        const d = w.cam().dir;
        out.push(angle(prev, d));
        prev = d;
      }
      return out;
    };
    // the fingers lift: a fast geometric decay, and macOS momentum proper (~4% per frame)
    const fast = steps(0.9);
    const slow = steps(0.96);
    w.reset();
    // a hand slowing down wobbles in size and direction
    const wobble = [30, 26, 27, 21, 22, 16, 17, 12, 13, 9, 10, 7, 8, 5, 6];
    const start = w.cam().dir;
    for (const [i, m] of wobble.entries()) w.pad(canvas, -m, i % 2 ? 2 : -1);
    const byHand = angle(start, w.cam().dir);
    // fingers back on the pad mid-glide take over again at full speed
    for (let i = 0; i < 8; i++) w.pad(canvas, -40, 0);
    for (let i = 1; i < 12; i++) w.pad(canvas, -Math.round(40 * 0.96 ** i), 0);
    const before = w.cam().dir;
    w.pad(canvas, 30, 0);
    const pickup = angle(before, w.cam().dir);
    return { fast, slow, byHand, pickup };
    function angle(a: number[], b: number[]) {
      return Math.acos(Math.min(1, a.reduce((s, v, i) => s + v * b[i], 0)));
    }
  });
  const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
  const full = 40 * 0.0065;
  for (const s of [r.fast, r.slow]) {
    // no brake: a steady exponential glide, never a sudden drop (the old damping fell 1 → 0.36 at release)
    for (let i = 1; i < 12; i++) expect(s[i]).toBeGreaterThan(s[i - 1] * 0.6 - 1e-4);
    // but it settles within a few hundred ms instead of macOS's ~1.5 s
    expect(sum(s.slice(20))).toBeLessThan(0.01);
  }
  // a short glide: a few full-speed frames' worth, not the ~25 of an undamped macOS tail
  expect(sum(r.slow)).toBeGreaterThan(full * 2);
  expect(sum(r.slow)).toBeLessThan(full * 7);
  // it isn't mistaken for momentum: undamped, this wobble turns the view 1.29 rad (1.49 rad of yaw)
  expect(r.byHand).toBeGreaterThan(1.27);
  // (yaw about Z turns the view by a bit less than the yaw angle: it looks down at the model)
  expect(r.pickup).toBeGreaterThan(30 * 0.0065 * 0.75);
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
