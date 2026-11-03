// Glue unions: solids that only touch fuse by sewing their touching faces, with the same names and
// provenance as a normal union; a broken promise falls back to a normal union with a warning.
import { beforeAll, expect, test } from "bun:test";
import { loadKernel } from "@parasocial/kernel";
import { OpCache, names } from "@parasocial/naming";
import { PartContext, runPart } from "../src/internal";
import { part, box, cylinder, sketch, plane, gear, type Solid } from "../src";

beforeAll(async () => {
  await loadKernel();
});

function run(fn: () => Solid, cache = new OpCache()) {
  cache.begin();
  let s!: Solid;
  const r = runPart(part("g", () => (s = fn())), new PartContext({ part: "g", file: "studios/g.ts", cache }));
  expect(r.problems.filter((p) => p.severity === "error").map((p) => p.message)).toEqual([]);
  return { s, warnings: r.problems.filter((p) => p.severity === "warning").map((p) => p.message) };
}

const sorted = (s: Solid, kind: "face" | "edge" | "vertex") => names(s.record, kind).map((n) => n.str).sort();

/** Glue and normal union of the same inputs agree: volume, validity, every face and edge name, and the edges the union created. */
function sameAsNormal(make: (glue: boolean) => Solid) {
  const created: Record<string, string[]> = {};
  const withCreated = (glue: boolean) => () => {
    const s = make(glue);
    created[String(glue)] = s.edges({ createdBy: "joined" }).names().sort();
    return s;
  };
  const g = run(withCreated(true));
  const n = run(withCreated(false));
  expect(g.warnings.filter((w) => !/matched no edges/.test(w))).toEqual([]);
  expect(g.s.isValid()).toBe(true);
  expect(g.s.volume()).toBeCloseTo(n.s.volume(), 2);
  expect(sorted(g.s, "face")).toEqual(sorted(n.s, "face"));
  expect([...new Set(sorted(g.s, "edge"))]).toEqual([...new Set(sorted(n.s, "edge"))]);
  expect(created.true).toEqual(created.false);
  return g.s;
}

test("a boss standing on a plate glues (partial coincidence) with a normal union's names", () => {
  const s = sameAsNormal((glue) => box(40, 30, 5, { tag: "plate" }).union(cylinder(4, 10, { at: [12, 10, 5], tag: "boss" }), { tag: "joined", glue }));
  expect(s.faces().length).toBe(6 + 2); // plate's 6 (top imprinted) + boss side and top
});

test("stacked blocks merge their flush sides like a normal union", () => {
  // the two blocks' x/y sides are coplanar and adjacent: one face each after the union
  sameAsNormal((glue) => box(20, 20, 5, { tag: "lower" }).union(box(20, 20, 5, { tag: "upper" }).translate([0, 0, 5]), { tag: "joined", glue }));
});

test("coaxial cylinders glue end to end, their sides merging", () => {
  sameAsNormal((glue) => cylinder(5, 10, { tag: "a" }).union(cylinder(5, 8, { at: [0, 0, 10], tag: "b" }), cylinder(3, 4, { at: [0, 0, 18], tag: "c" }), { tag: "joined", glue }));
});

test("mirror union with glue: a half against its mirror plane", () => {
  const half = () => sketch(plane.XY, { tag: "outline" }).polyline([[0, 0], [20, 0], [20, 10], [5, 20], [0, 20]]).extrude(6, { tag: "half" });
  const g = run(() => half().mirror("YZ", { union: true, glue: true, tag: "whole" }));
  const n = run(() => half().mirror("YZ", { union: true, tag: "whole" }));
  expect(g.warnings).toEqual([]);
  expect(g.s.volume()).toBeCloseTo(n.s.volume(), 3);
  expect(sorted(g.s, "face")).toEqual(sorted(n.s, "face"));
});

test("overlapping inputs fall back to a normal union with a warning at the source line", () => {
  const sunk = () => box(40, 30, 5, { tag: "plate" }).union(cylinder(4, 10, { at: [12, 10, 3], tag: "boss" }), { tag: "joined", glue: true });
  const cache = new OpCache();
  const g = run(sunk, cache);
  expect(g.warnings.length).toBe(1);
  // (in a studio the message ends with the source line, e.g. "(bracket.ts:12)")
  expect(g.warnings[0]).toMatch(/^glue fell back to a normal union: inputs overlap: a point of input 2 at \(.*\) lies inside input 1/);
  const n = run(() => box(40, 30, 5, { tag: "plate" }).union(cylinder(4, 10, { at: [12, 10, 3], tag: "boss" }), { tag: "joined" }));
  expect(g.s.volume()).toBeCloseTo(n.s.volume(), 3);
  expect(sorted(g.s, "face")).toEqual(sorted(n.s, "face"));
  // a cached rerun still reports it
  expect(run(sunk, cache).warnings).toEqual(g.warnings);
});

test("coplanar faces facing the same way (one block inside another's footprint) are an overlap", () => {
  const g = run(() => box(20, 20, 10, { tag: "a" }).union(box(10, 10, 10, { tag: "b" }), { glue: true }));
  expect(g.warnings[0]).toMatch(/glue fell back to a normal union: inputs overlap/);
  expect(g.s.volume()).toBeCloseTo(4000, 3);
});

test("glue on herringbone halves: a helical gear and its mirror image (identical touching faces)", () => {
  sameAsNormal((glue) => gear({ teeth: 20, module: 2, width: 5, helix: 20, tag: "arm" }).mirror("XY", { union: true, tag: "joined", glue }));
}, 30_000);

test("glue is a union option only", () => {
  const cache = new OpCache();
  cache.begin();
  const r = runPart(part("g", () => box(10, 10, 10).subtract(box(5, 5, 5), { glue: true } as any)), new PartContext({ part: "g", file: "studios/g.ts", cache }));
  expect(r.problems[0]?.message).toMatch(/glue applies only to union/);
});
