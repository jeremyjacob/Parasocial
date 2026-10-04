// Sketch outlines: polyline names and per-corner fillets, offset joins and multi-region offsets.
import { beforeAll, expect, test } from "bun:test";
import { loadKernel, isValid } from "@parasocial/kernel";
import { OpCache } from "@parasocial/naming";
import { PartContext, runPart } from "../src/internal";
import { part, sketch, plane, type Solid, type Sketch } from "../src";

beforeAll(async () => {
  await loadKernel();
});

const run = (fn: () => Solid) => {
  const cache = new OpCache();
  cache.begin();
  return runPart(part("t", fn), new PartContext({ part: "t", file: "studios/t.ts", cache }));
};
const errors = (r: ReturnType<typeof run>) => r.problems.filter((p) => p.severity === "error").map((p) => p.message);
/** Extrude 1 mm (volume = profile area) and return the solid. */
function slab(sk: () => Sketch): Solid {
  let s!: Solid;
  const r = run(() => (s = sk().extrude(1, { tag: "slab" })));
  expect(errors(r)).toEqual([]);
  expect(isValid(s.record.shape)).toBe(true);
  return s;
}

const L: [number, number][] = [[0, 0], [40, 0], [40, 10], [15, 10], [15, 30], [0, 30]]; // area 700

test("offset join: sharp insets keep the reflex corner sharp, round (default) rounds it", () => {
  const sharp = slab(() => sketch(plane.XY).polyline(L, { tag: "l" }).offset(-2, { join: "sharp" }));
  // 36 × 6 + 11 × 20
  expect(sharp.volume()).toBeCloseTo(436, 6);
  expect(sharp.faces().length).toBe(8);
  const round = slab(() => sketch(plane.XY).polyline(L, { tag: "l" }).offset(-2));
  // round: the reflex corner's inset is a quarter circle of r 2 about (15, 10), bulging past (13, 8)
  expect(round.volume()).toBeCloseTo(436 + (4 - Math.PI), 6);
  expect(round.faces().length).toBe(9);
  // edges keep their segment's name; the cache tells the joins apart
  expect(sharp.faces().names()).toContain("t/slab · side · l/side4+offset");
  expect(sharp.faces().list().filter((f) => f.surface === "cylinder").length).toBe(0);
  expect(round.faces("%cylinder").length).toBe(1);
});

test("offset works on multi-region sketches and holes", () => {
  const two = slab(() => sketch(plane.XY).rect(10, 10, { at: [-20, 0] }).rect(10, 10, { at: [20, 0] }).offset(-1, { join: "sharp" }));
  expect(two.volume()).toBeCloseTo(2 * 64, 6);
  const grown = slab(() => sketch(plane.XY).rect(10, 10, { at: [-20, 0] }).rect(10, 10, { at: [20, 0] }).offset(1));
  expect(grown.volume()).toBeCloseTo(2 * (140 + Math.PI), 6);
  const ring = slab(() => sketch(plane.XY).rect(30, 30, { tag: "outline" }).circle([0, 0], 5, { tag: "bore" }).circle([40, 0], 3).offset(-1));
  expect(ring.volume()).toBeCloseTo(28 * 28 - 36 * Math.PI + 4 * Math.PI, 6);
  expect(ring.faces().names()).toContain("t/slab · side · bore+offset");
});

test("offset rejects an unknown join", () => {
  const r = run(() => sketch(plane.XY).rect(10, 10).offset(-1, { join: "miter" as any }).extrude(1));
  expect(errors(r)[0]).toContain('offset join must be "round" or "sharp"');
});

test("polyline names its segments <tag>/sideN with or without fillets", () => {
  const tri: [number, number][] = [[0, 0], [20, 0], [0, 10]];
  const sides = ["t/slab · side · tri/side1", "t/slab · side · tri/side2", "t/slab · side · tri/side3"];
  expect(slab(() => sketch(plane.XY).polyline(tri, { tag: "tri" })).faces("tri").names().sort()).toEqual(sides);
  expect(slab(() => sketch(plane.XY).polyline(tri, { tag: "tri", fillet: 1 })).faces("tri").names().filter((n) => /side\d/.test(n)).sort()).toEqual(sides);
  // untagged: named after the sketch; a repeated first point doesn't add a side
  const plain = slab(() => sketch(plane.XY, { tag: "sk" }).polyline([...tri, [0, 0]]));
  expect(plain.faces("polyline1").names().sort()).toEqual(sides.map((n) => n.replace("tri/", "sk/polyline1/")));
  // an open polyline continues as a path
  const open = slab(() => sketch(plane.XY, { tag: "sk" }).polyline(tri.slice(0, 2), { close: false, tag: "base" }).lineTo([0, 10]).close({ tag: "back" }));
  expect(open.faces("side").names().sort()).toEqual(["t/slab · side · back", "t/slab · side · base/side1", "t/slab · side · sk/line1"]);
});

test("polyline fillet per corner: { pointIndex: radius }, the rest stay sharp", () => {
  const sq: [number, number][] = [[0, 0], [20, 0], [20, 20], [0, 20]];
  const one = slab(() => sketch(plane.XY).polyline(sq, { tag: "sq", fillet: { 2: 3 } }));
  expect(one.volume()).toBeCloseTo(400 - (9 - (9 * Math.PI) / 4), 6);
  expect(one.faces("%cylinder").names()).toEqual(["t/slab · side · sq/corner3"]);
  const two = slab(() => sketch(plane.XY).polyline(sq, { tag: "sq", fillet: { 0: 2, 2: 5 } }));
  expect(two.volume()).toBeCloseTo(400 - (4 + 25) * (1 - Math.PI / 4), 6);
  expect(two.faces("%cylinder").length).toBe(2);
  // a corner that fills its sides exactly still works (the side between them vanishes)
  expect(slab(() => sketch(plane.XY).polyline([[0, 0], [10, 0], [10, 4], [0, 4]], { fillet: { 1: 2, 2: 2 } })).volume()).toBeCloseTo(40 - 8 * (1 - Math.PI / 4), 6);
});

test("polyline fillet that doesn't fit, or names no corner, is a clear error", () => {
  const thin: [number, number][] = [[0, 0], [10, 0], [10, 4], [0, 4]];
  const tooBig = errors(run(() => sketch(plane.XY).polyline(thin, { fillet: { 1: 3, 2: 3 } }).extrude(1)))[0];
  expect(tooBig).toContain("polyline fillet 3 at point 1 and 3 at point 2 doesn't fit: side 2 is 4 long and the roundings need 6 of it");
  expect(errors(run(() => sketch(plane.XY).polyline(thin, { fillet: 3 }).extrude(1)))[0]).toContain("doesn't fit");
  expect(errors(run(() => sketch(plane.XY).polyline(thin, { fillet: { 4: 1 } }).extrude(1)))[0]).toContain('corner "4" is not a point index (0…3)');
  expect(errors(run(() => sketch(plane.XY).polyline(thin, { fillet: { 1: -1 } }).extrude(1)))[0]).toContain("must not be negative");
});
