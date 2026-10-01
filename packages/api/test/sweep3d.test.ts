import { beforeAll, expect, test } from "bun:test";
import { loadKernel, isValid, explore, vertexPoint, shapeKind } from "@parasocial/kernel";
import { OpCache, names } from "@parasocial/naming";
import { PartContext, runPart } from "../src/internal";
import { part, sketch, plane, path3d, helix, pipe, cylinder, type Solid } from "../src";

beforeAll(async () => {
  await loadKernel();
});

const run = (name: string, fn: () => Solid, cache = new OpCache()) => {
  cache.begin();
  return runPart(part(name, fn), new PartContext({ part: name, file: `studios/${name}.ts`, cache }));
};
const faceNames = (r: ReturnType<typeof run>) => names(r.record!, "face").map((n) => n.str);
const solids = (r: ReturnType<typeof run>) => explore(r.record!.shape, "solid").items.length;

test("spring: circle swept along a helix", () => {
  const R = 10, pitch = 4, turns = 5, w = 1;
  let s!: Solid;
  const r = run("spring", () => (s = sketch(plane.XZ, { tag: "wire" }).circle([R, 0], w, { tag: "wire" }).sweep(helix({ radius: R, pitch, turns, tag: "coil" }), { tag: "spring" })));
  expect(r.problems).toEqual([]);
  expect(isValid(r.record!.shape)).toBe(true);
  expect(solids(r)).toBe(1);
  const L = turns * Math.hypot(2 * Math.PI * R, pitch);
  expect(Math.abs(s.volume() / (Math.PI * w * w * L) - 1)).toBeLessThan(0.02);
  const f = faceNames(r);
  console.log(f);
  expect(f).toContain("spring/spring · cap.start");
  expect(f).toContain("spring/spring · cap.end");
  expect(f.filter((n) => n === "spring/spring · side · wire").length).toBeGreaterThan(0);
  // names are stable across a pitch change
  const r2 = run("spring", () => sketch(plane.XZ, { tag: "wire" }).circle([R, 0], w, { tag: "wire" }).sweep(helix({ radius: R, pitch: 5, turns, tag: "coil" }), { tag: "spring" }));
  expect(faceNames(r2).sort()).toEqual([...f].sort());
});

test("thread: triangular profile along a helix stays upright (no twist)", () => {
  const R = 5, pitch = 2, h = 0.8;
  let s!: Solid;
  // 3.25 turns: the end is a quarter turn round from the start
  const r = run("thread", () => (s = sketch(plane.XZ).polyline([[R, -h], [R + 1, 0], [R, h]], { tag: "tooth" }).sweep(helix({ radius: R, pitch, turns: 3.25 }), { tag: "thread" })));
  expect(r.problems).toEqual([]);
  expect(isValid(r.record!.shape)).toBe(true);
  expect(solids(r)).toBe(1);
  // end cap: the same triangle rotated 90° about Z and raised 6.5
  const cap = r.record!.topo.faces.items[faceNames(r).indexOf("thread/thread · cap.end")];
  const pts = explore(cap, "vertex").items.map(vertexPoint).sort((a, b) => a[2] - b[2]);
  const want = [[0, R, 6.5 - h], [0, R + 1, 6.5], [0, R, 6.5 + h]];
  pts.forEach((p, i) => p.forEach((c, k) => expect(Math.abs(c - want[i][k])).toBeLessThan(1e-3)));
  const bb = s.boundingBox();
  expect(bb.max[2]).toBeLessThan(6.5 + h + 1e-3);
  expect(bb.min[2]).toBeGreaterThan(-h - 1e-3);
  // Pappus: area × path length of the centroid
  const rc = R + 1 / 3;
  expect(Math.abs(s.volume() / (h * 3.25 * Math.hypot(2 * Math.PI * rc, pitch)) - 1)).toBeLessThan(0.01);
  const f = faceNames(r);
  console.log(f);
  // one face per profile segment per half turn (helixEdges), sharing the segment's name
  expect(new Set(f.filter((n) => n.startsWith("thread/thread · side · "))).size).toBe(3);
  expect(f).toContain("thread/thread · side · tooth");
});

test("sweep along a 3D path with line, arc and spline segments", () => {
  const r = run("pipe", () =>
    sketch(plane.YZ)
      .circle([0, 0], 1.5, { tag: "bore" })
      .sweep(
        path3d([0, 0, 0], { tag: "route" })
          .lineTo([20, 0, 0])
          .arcTo([20 + 10 * Math.SQRT1_2, 10 - 10 * Math.SQRT1_2, 0], [30, 10, 0], { tag: "bend" })
          .splineTo([[32, 25, 8], [30, 40, 15]], { startTangent: [0, 1, 0] }),
        { tag: "pipe" },
      ),
  );
  expect(r.problems).toEqual([]);
  expect(isValid(r.record!.shape)).toBe(true);
  expect(shapeKind(r.record!.shape)).toBe("solid");
  const f = faceNames(r);
  console.log(f);
  expect(f).toContain("pipe/pipe · side · route/line1 · bore");
  expect(f).toContain("pipe/pipe · side · bend · bore");
  expect(f).toContain("pipe/pipe · side · route/spline1 · bore");
  expect(f).toContain("pipe/pipe · cap.start");
  expect(f).toContain("pipe/pipe · cap.end");
  expect(new Set(f).size).toBe(f.length);
});

test("left-handed, tapered helix along X; untagged paths get default names", () => {
  const r = run("coil", () => sketch(plane.XY).rect(0.8, 0.8, { at: [0, 4] }).sweep(helix({ radius: 4, pitch: 2, height: 6, axis: "X", leftHanded: true, taper: 5 })));
  expect(r.problems).toEqual([]);
  expect(isValid(r.record!.shape)).toBe(true);
  expect(solids(r)).toBe(1);
  console.log(faceNames(r));
});

test("helpful errors", () => {
  const err = (fn: () => Solid) => run("bad", fn).problems[0]?.message ?? "";
  expect(err(() => sketch(plane.XZ).circle([5, 0], 1).sweep(helix({ radius: 0, pitch: 2, turns: 3 })))).toMatch(/radius must be a positive number/);
  expect(err(() => sketch(plane.XZ).circle([5, 0], 1).sweep(helix({ radius: 5, pitch: 2 })))).toMatch(/exactly one of height or turns/);
  expect(err(() => sketch(plane.YZ.at([5, 0, 0])).circle([0, 0], 1).sweep(path3d([5, 0, 0]).lineTo([5, 0, 10])))).toMatch(/parallel to the path/);
  expect(err(() => sketch(plane.XZ).circle([5, 0], 1).sweep(helix({ radius: 5, pitch: 3, turns: 1 }), { orientation: "twisty" as any }))).toMatch(/orientation must be/);
  expect(err(() => sketch(plane.XZ).circle([5, 0], 1).circle([5, 0], 0.5).sweep(helix({ radius: 5, pitch: 3, turns: 1 })))).toMatch(/holes/);
  expect(err(() => sketch(plane.XZ).circle([5, 0], 1).sweep({} as any))).toMatch(/needs a path/);
});

test("pipe: a rope through 20 points stays round at the corners", () => {
  const pts: [number, number, number][] = [...Array(21).keys()].map((i) => [i * 10, 15 * Math.sin(i / 3), 8 * Math.cos(i / 2)]);
  const L = pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1], p[2] - pts[i][2]), 0);
  let rope!: Solid, smooth!: Solid;
  const r = run("rope", () => {
    rope = pipe(pts, 2, { tag: "rope" });
    smooth = pipe(pts, 2, { tag: "smooth", smooth: true });
    return rope;
  });
  expect(r.problems).toEqual([]);
  expect(isValid(rope.record.shape)).toBe(true);
  expect(isValid(smooth.record.shape)).toBe(true);
  expect(solids(r)).toBe(1);
  // round bends: the section stays a full circle, so the volume is ~πr²L (a sheared corner loses up to 40%)
  expect(Math.abs(rope.volume() / (Math.PI * 4 * L) - 1)).toBeLessThan(0.01);
  expect(Math.abs(smooth.volume() / (Math.PI * 4 * L) - 1)).toBeLessThan(0.03);
  const f = faceNames(r);
  expect(f).toContain("rope/rope · side · path1/line1 · wall");
  expect(f).toContain("rope/rope · side · bend · wall");
  expect(f).toContain("rope/rope · cap.end");
});

test("sweep along a polyline path3d bends round its corners instead of shearing the profile", () => {
  let s!: Solid;
  const r = run("bent", () => (s = sketch(plane.YZ).circle([0, 0], 1).sweep(path3d([0, 0, 0]).lineTo([20, 0, 0]).lineTo([20, 20, 0]).lineTo([20, 20, 20]))));
  expect(r.problems).toEqual([]);
  expect(Math.abs(s.volume() / (Math.PI * 60) - 1)).toBeLessThan(0.01);
});

test("pipe along a helix cut from a drum: a 10-turn groove subtracts the right volume", () => {
  const R = 20, pitch = 3, turns = 10, g = 1.2;
  let drum!: Solid;
  const r = run("drum", () => (drum = cylinder(R, 40, { at: [0, 0, -5], tag: "drum" }).subtract(pipe(helix({ radius: R, pitch, turns }), g, { tag: "groove" }), { tag: "cut" })));
  expect(r.problems).toEqual([]);
  expect(isValid(r.record!.shape)).toBe(true);
  // the part of the groove's circle inside the drum, swept along the helix
  const a = Math.acos((R * R + g * g - R * R) / (2 * R * g)), b = Math.acos((R * R + R * R - g * g) / (2 * R * R));
  const lens = g * g * a + R * R * b - 0.5 * Math.sqrt((-R + g + R) * (R + g - R) * (R - g + R) * (R + g + R));
  const removed = Math.PI * R * R * 40 - drum.volume();
  expect(Math.abs(removed / (lens * turns * Math.hypot(2 * Math.PI * R, pitch)) - 1)).toBeLessThan(0.02);
  // one side face per half turn, all with the same name
  expect(faceNames(r).filter((n) => n === "drum/groove · side · wall").length).toBeGreaterThanOrEqual(turns * 2);
});

test("threaded rod: thread unioned onto a cylinder", () => {
  const r = run("bolt", () => {
    const rod = sketch(plane.XY).circle([0, 0], 5, { tag: "shank" }).extrude(10, { tag: "rod" });
    return sketch(plane.XZ).polyline([[4.8, 0.2], [5.8, 1], [4.8, 1.8]], { tag: "flank" }).sweep(helix({ radius: 4.8, pitch: 2, turns: 4, tag: "thread" }), { tag: "thread", mode: "add", target: rod });
  });
  expect(r.problems).toEqual([]);
  expect(isValid(r.record!.shape)).toBe(true);
  expect(solids(r)).toBe(1);
});
