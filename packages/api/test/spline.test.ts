import { beforeAll, expect, test } from "bun:test";
import { loadKernel, isValid, massProps, edgeInfo, edgeTangent, explore } from "@parasocial/kernel";
import { OpCache } from "@parasocial/naming";
import { PartContext, runPart, type Solid } from "@parasocial/api/internal";
import { part, sketch, plane } from "../src";

beforeAll(async () => { await loadKernel(); });

const run = (body: () => Solid) => {
  const cache = new OpCache();
  cache.begin();
  return runPart(part("P", body), new PartContext({ part: "p", file: "studios/p.ts", cache }));
};
const edgesOf = (shape: any): any[] => explore(shape, "edge").items;
const ring = (n: number, r: number, c: [number, number] = [0, 0]): [number, number][] => [...Array(n)].map((_, i) => [c[0] + r * Math.cos((2 * Math.PI * i) / n), c[1] + r * Math.sin((2 * Math.PI * i) / n)]);

test("closed spline extrudes to a valid, round solid", () => {
  const r = run(() => sketch(plane.XY).spline(ring(8, 10), { tag: "loop" }).extrude(5));
  expect(r.problems).toEqual([]);
  expect(isValid(r.record!.shape)).toBe(true);
  // a smooth periodic loop through 8 points on a circle is very nearly the circle
  expect(massProps(r.record!.shape).volume / (Math.PI * 100 * 5)).toBeCloseTo(1, 2);
  // no seam: the loop is a single closed spline edge, tangent-continuous at its start
  const loop = edgesOf(r.record!.shape).filter((e) => edgeInfo(e).curve === "bspline" && edgeInfo(e).closed);
  expect(loop.length).toBe(2);
  const [a, b] = [edgeTangent(loop[0], false), edgeTangent(loop[0], true)];
  expect(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]).toBeGreaterThan(1 - 1e-9);
});

test("a hole inside a spline that bows outside its points is cut, not added", () => {
  // closed spline through a diamond's corners bulges to ~r 19 on the diagonals; the hole at
  // (11, 11) sits outside the diamond but inside the curve
  const pts: [number, number][] = [[20, 0], [0, 20], [-20, 0], [0, -20]];
  const outer = run(() => sketch(plane.XY).spline(pts).extrude(2));
  const holed = run(() => sketch(plane.XY).spline(pts).circle([11, 11], 1.5).extrude(2));
  expect(holed.problems).toEqual([]);
  expect(isValid(holed.record!.shape)).toBe(true);
  expect(massProps(holed.record!.shape).volume).toBeCloseTo(massProps(outer.record!.shape).volume - Math.PI * 1.5 ** 2 * 2, 1);
});

test("splineTo tangents, tangentArcTo from the real end tangent, mirror", () => {
  const r = run(() =>
    sketch(plane.XY)
      .moveTo([0, 0])
      .splineTo([[10, 8], [20, 5]], { startTangent: [1, 0], endTangent: [0, -3], tag: "s" })
      .tangentArcTo([30, 0], { tag: "arc" })
      .lineTo([30, -10])
      .lineTo([0, -10])
      .close()
      .extrude(3),
  );
  expect(r.problems).toEqual([]);
  expect(isValid(r.record!.shape)).toBe(true);
  // the arc leaves the spline heading -y
  const arc = edgesOf(r.record!.shape).find((e) => edgeInfo(e).curve === "circle" && Math.abs(edgeInfo(e).start[2]) < 1e-9)!;
  const i = edgeInfo(arc);
  const t = edgeTangent(arc, false);
  const [x, y] = Math.abs(i.start[0] - 20) < 1e-6 ? [t[0], t[1]] : (() => { const u = edgeTangent(arc, true); return [-u[0], -u[1]]; })();
  expect(x).toBeCloseTo(0, 6);
  expect(y).toBeCloseTo(-1, 6);

  // without an explicit end tangent, tangentArcTo uses the built curve's
  const free = run(() => sketch(plane.XY).moveTo([0, 0]).splineTo([[10, 8], [20, 5]]).tangentArcTo([30, 0]).lineTo([30, -10]).lineTo([0, -10]).close().extrude(3));
  expect(free.problems).toEqual([]);

  const half = run(() => sketch(plane.XY).moveTo([2, 0]).splineTo([[8, 6], [4, 12]], { startTangent: [1, 1], endTangent: [-1, 0] }).lineTo([2, 12]).close().extrude(1));
  const both = run(() => sketch(plane.XY).moveTo([2, 0]).splineTo([[8, 6], [4, 12]], { startTangent: [1, 1], endTangent: [-1, 0] }).lineTo([2, 12]).close().mirror().extrude(1));
  expect(both.problems).toEqual([]);
  expect(massProps(both.record!.shape).volume).toBeCloseTo(2 * massProps(half.record!.shape).volume, 2);
  const c = massProps(both.record!.shape).centroid;
  expect(c[0]).toBeCloseTo(0, 4);
});

test("bsplineTo is clamped to the cursor and last pole; weights make exact arcs", () => {
  // quarter disc: two lines + an exact rational quarter circle
  const r = run(() =>
    sketch(plane.XY).moveTo([0, 0]).lineTo([10, 0]).bsplineTo([[10, 10], [0, 10]], { degree: 2, weights: [1, Math.SQRT1_2, 1], tag: "q" }).close().extrude(1),
  );
  expect(r.problems).toEqual([]);
  expect(isValid(r.record!.shape)).toBe(true);
  expect(massProps(r.record!.shape).volume).toBeCloseTo((Math.PI * 100) / 4, 4);

  const closed = run(() => sketch(plane.XY).bspline(ring(6, 10)).circle([0, 0], 2).extrude(1));
  expect(closed.problems).toEqual([]);
  expect(isValid(closed.record!.shape)).toBe(true);
  const m = run(() => sketch(plane.XY).moveTo([1, 0]).bsplineTo([[6, 2], [6, 8], [1, 10]]).close().mirror().extrude(1));
  expect(m.problems).toEqual([]);
  expect(massProps(m.record!.shape).centroid[0]).toBeCloseTo(0, 4);
});

test("spline input errors surface at the call", () => {
  const msg = (body: () => Solid) => run(body).problems.map((p) => p.message).join("\n");
  expect(msg(() => sketch(plane.XY).moveTo([0, 0]).splineTo([[5, 5]], { endTangent: [0, 0] }).close().extrude(1))).toContain("endTangent must be a non-zero direction");
  expect(msg(() => sketch(plane.XY).spline([[0, 0], [5, 5]]).extrude(1))).toContain("closed spline needs at least 3 distinct points");
  expect(msg(() => sketch(plane.XY).moveTo([0, 0]).bsplineTo([[5, 5], [10, 0]], { degree: 3 }).close().extrude(1))).toContain("degree-3 bspline needs at least 4 control points");
  expect(msg(() => sketch(plane.XY).moveTo([0, 0]).bsplineTo([[5, 5], [10, 0]], { degree: 2, knots: [0, 1, 2], mults: [2, 2, 2] }).close().extrude(1))).toContain("clamped ends");
});
