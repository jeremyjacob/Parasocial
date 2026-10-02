// In-script measurements and design-rule checks.
import { beforeAll, expect, test } from "bun:test";
import { loadKernel } from "@parasocial/kernel";
import { OpCache } from "@parasocial/naming";
import { PartContext, runPart } from "../src/internal";
import { part, box, cylinder, sketch, plane, measure, check, param, type Solid } from "../src";

beforeAll(async () => {
  await loadKernel();
});

const run = (name: string, fn: () => Solid, cache = new OpCache(), overrides: Record<string, number> = {}) => {
  cache.begin();
  return runPart(part(name, fn), new PartContext({ part: name, file: `studios/${name}.ts`, cache, overrides }));
};
const near = (a: number, b: number, tol = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(tol);

test("volume, area, length, centroid, bounding box", () => {
  const got: Record<string, unknown> = {};
  const r = run("m", () => {
    const b = box(10, 20, 30, { tag: "blk" });
    got.volume = measure.volume(b);
    got.area = measure.area(b);
    got.topArea = measure.area(b.faces(">Z"));
    got.topLen = measure.length(b.faces(">Z").edges());
    got.c = measure.centroid(b);
    got.cTop = measure.centroid(b.faces(">Z"));
    got.cEdge = measure.centroid(b.edges(">Z").edges().of(b.faces(">X")));
    got.cVerts = measure.centroid(b.faces(">Z").vertices());
    got.bb = measure.boundingBox(b);
    got.bbPts = measure.boundingBox([[0, 0, 0], [1, -2, 3]]);
    const cyl = cylinder(5, 10, { tag: "c" });
    got.circ = measure.length(cyl.edges("%circle"));
    got.cylBB = measure.boundingBox(cyl);
    return b;
  });
  expect(r.problems).toEqual([]);
  near(got.volume as number, 6000);
  near(got.area as number, 2 * (200 + 300 + 600));
  near(got.topArea as number, 200);
  near(got.topLen as number, 60);
  (got.c as number[]).forEach((v, i) => near(v, [5, 10, 15][i]));
  (got.cTop as number[]).forEach((v, i) => near(v, [5, 10, 30][i]));
  (got.cVerts as number[]).forEach((v, i) => near(v, [5, 10, 30][i]));
  const bb = got.bb as { min: number[]; max: number[]; size: number[]; center: number[] };
  // exact: no tolerance padding, no mesh dependence
  expect(bb.size).toEqual([10, 20, 30]);
  expect(bb.center).toEqual([5, 10, 15]);
  expect((got.bbPts as { size: number[] }).size).toEqual([1, 2, 3]);
  near(got.circ as number, 2 * 2 * Math.PI * 5);
  (got.cylBB as { size: number[] }).size.forEach((v, i) => near(v, [10, 10, 10][i]));
});

test("distance, minClearance, overlap", () => {
  const got: Record<string, number | object> = {};
  run("m", () => {
    const a = box(10, 10, 10, { tag: "a" });
    const b = box(10, 10, 10, { tag: "b" }).translate([13, 0, 0], { tag: "bMove" });
    const c = box(10, 10, 10, { tag: "c" }).translate([5, 5, 0], { tag: "cMove" });
    const inner = box(2, 2, 2, { tag: "inner" }).translate([4, 4, 4], { tag: "innerMove" });
    got.ab = measure.distance(a, b);
    got.abClear = measure.minClearance(a, b);
    got.closest = measure(a, b);
    got.facePt = measure.distance(a.faces(">Z"), [5, 5, 12]);
    got.ptPt = measure.distance([0, 0, 0], [3, 4, 0]);
    got.edgeEdge = measure.distance(a.edges(">Z").edges().of(a.faces(">X")), b.faces("<X"));
    got.acClear = measure.minClearance(a, c);
    got.acOverlap = measure.overlap(a, c);
    got.abOverlap = measure.overlap(a, b);
    got.insideClear = measure.minClearance(a, inner);
    return a;
  });
  near(got.ab as number, 3);
  near(got.abClear as number, 3);
  near((got.closest as { distance: number }).distance, 3);
  // one shape per function: Closest also carries `value` and compares / prints as its distance
  const cl = got.closest as { distance: number; value: number; a: number[] };
  expect(cl.value).toBe(cl.distance);
  expect(+cl).toBe(cl.distance);
  expect((cl as unknown as number) > 2.5 && (cl as unknown as number) < 3.5).toBe(true);
  expect(`${cl}`).toBe(String(cl.distance));
  expect(Object.keys(cl)).toEqual(["distance", "value", "a", "b"]);
  near(got.facePt as number, 2);
  near(got.ptPt as number, 5);
  near(got.edgeEdge as number, 3);
  near(got.acClear as number, 0);
  near(got.acOverlap as number, 250);
  expect(got.abOverlap).toBe(0);
  // one solid inside another: no clearance
  near(got.insideClear as number, 0);
});

test("check(): a failed design rule names the rule and keeps the last good solid", () => {
  const cache = new OpCache();
  const body = () => {
    const gap = param("gap", 3);
    const frame = box(10, 10, 10, { tag: "frame" });
    const drum = cylinder(4, 10, { tag: "drum" }).translate([10 + gap + 4, 5, 0], { tag: "place" });
    const clear = measure.minClearance(drum, frame);
    check(clear >= 2, `drum must clear the frame by 2 mm (has ${clear.toFixed(2)} mm)`);
    return frame.union(drum, { tag: "all" });
  };
  const ok = run("rule", body, cache);
  expect(ok.ok).toBe(true);
  const bad = run("rule", body, cache, { gap: 1.5 });
  expect(bad.ok).toBe(false);
  expect(bad.problems[0].kind).toBe("rule");
  expect(bad.problems[0].message).toMatch(/^design rule failed: drum must clear the frame by 2 mm \(has 1\.50 mm\)/);
  // the viewport keeps showing the last op that succeeded
  expect(bad.record).toBeDefined();
});

test("measurements are memoized on cached records and deterministic", () => {
  const cache = new OpCache();
  const vals: number[] = [];
  const body = () => {
    const b = sketch(plane.XY).circle([0, 0], 7).extrude(12, { tag: "rod" });
    vals.push(measure.volume(b), measure.area(b.faces("%cylinder")), measure.boundingBox(b).size[0]);
    return b;
  };
  run("memo", body, cache);
  const first = [...vals];
  vals.length = 0;
  const r2 = run("memo", body, cache);
  expect(r2.timings.cacheMisses).toBe(0);
  expect(vals).toEqual(first);
  near(first[0], Math.PI * 49 * 12, 1e-6);
});

test("measure errors point at the call", () => {
  const msg = (fn: () => Solid) => run("bad", fn).problems[0]?.message ?? "";
  expect(msg(() => {
    const b = box(1, 1, 1);
    measure.volume(b.faces(">Z") as any);
    return b;
  })).toMatch(/measure\.volume\(x\): x must be a solid/);
  expect(msg(() => {
    const b = box(1, 1, 1);
    measure.length(b.faces(">Z") as any);
    return b;
  })).toMatch(/must be an edge selection/);
  expect(msg(() => {
    const b = box(1, 1, 1);
    measure.distance(b, "lid" as any);
    return b;
  })).toMatch(/expected a solid, a selection/);
});
