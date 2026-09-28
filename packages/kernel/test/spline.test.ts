import { beforeAll, expect, test } from "bun:test";
import { loadKernel, splineEdge, bsplineEdge, edgeInfo, edgeTangent, sampleEdge, type Vec3 } from "../src";
beforeAll(async () => { await loadKernel(); });

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const ring = (n: number, r: number): Vec3[] => [...Array(n)].map((_, i) => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n), 0]);

test("spline edge through points", () => {
  const e = splineEdge([[0, 0, 0], [10, 5, 0], [20, 0, 0]]);
  expect(edgeInfo(e).curve).toBe("bspline");
  expect(edgeInfo(e).length).toBeGreaterThan(20);
});

test("closed spline is periodic and smooth at the seam", () => {
  const e = splineEdge(ring(6, 10), { closed: true });
  const i = edgeInfo(e);
  expect(i.closed).toBe(true);
  expect(i.start[0]).toBeCloseTo(10, 6);
  expect(dot(edgeTangent(e, false), edgeTangent(e, true))).toBeGreaterThan(1 - 1e-9);
  expect(i.length).toBeCloseTo(2 * Math.PI * 10, 0);
  // repeating the first point is tolerated
  expect(edgeInfo(splineEdge([...ring(6, 10), ring(6, 10)[0]], { closed: true })).length).toBeCloseTo(i.length, 6);
});

test("tangent-constrained spline ends match the requested directions", () => {
  const e = splineEdge([[0, 0, 0], [10, 0, 0], [20, 10, 0]], { startTangent: [0, 5, 0], endTangent: [1, -1, 0] });
  const t0 = edgeTangent(e, false),
    t1 = edgeTangent(e, true);
  expect(t0[0]).toBeCloseTo(0, 6);
  expect(t0[1]).toBeCloseTo(1, 6);
  expect(t1[0]).toBeCloseTo(Math.SQRT1_2, 6);
  expect(t1[1]).toBeCloseTo(-Math.SQRT1_2, 6);
  // one end only
  const f = splineEdge([[0, 0, 0], [10, 0, 0], [20, 10, 0]], { endTangent: [0, 1, 0] });
  expect(edgeTangent(f, true)[1]).toBeCloseTo(1, 6);
  // per-point tangents
  const g = splineEdge([[0, 0, 0], [10, 0, 0], [20, 0, 0]], { tangents: [null, [1, 1, 0], null] });
  expect(sampleEdge(g, 4).length).toBe(4);
});

test("bspline with default knots is clamped to its end poles", () => {
  const poles: Vec3[] = [[0, 0, 0], [5, 10, 0], [15, -10, 0], [20, 5, 0], [30, 0, 0]];
  const i = edgeInfo(bsplineEdge({ poles }));
  expect(i.curve).toBe("bspline");
  i.start.forEach((c, k) => expect(c).toBeCloseTo(poles[0][k], 9));
  i.end.forEach((c, k) => expect(c).toBeCloseTo(poles[4][k], 9));
  // fewer poles than degree + 1: default degree drops
  expect(edgeInfo(bsplineEdge({ poles: [[0, 0, 0], [10, 0, 0]] })).length).toBeCloseTo(10, 9);
  // flat knot vector
  const f = edgeInfo(bsplineEdge({ poles, degree: 2, knots: [0, 0, 0, 1, 2, 3, 3, 3] }));
  f.end.forEach((c, k) => expect(c).toBeCloseTo(poles[4][k], 9));
});

test("weighted bspline gives an exact quarter circle", () => {
  const e = bsplineEdge({ poles: [[10, 0, 0], [10, 10, 0], [0, 10, 0]], degree: 2, weights: [1, Math.SQRT1_2, 1] });
  for (const p of sampleEdge(e, 16)) expect(Math.hypot(p[0], p[1])).toBeCloseTo(10, 9);
  expect(edgeInfo(e).length).toBeCloseTo((Math.PI * 10) / 2, 4);
});

test("periodic bspline closes", () => {
  const e = bsplineEdge({ poles: ring(6, 10), periodic: true });
  expect(edgeInfo(e).closed).toBe(true);
  expect(dot(edgeTangent(e, false), edgeTangent(e, true))).toBeGreaterThan(1 - 1e-9);
});

test("spline and bspline errors are readable", () => {
  expect(() => splineEdge([[0, 0, 0], [0, 0, 0], [5, 0, 0]], { endTangent: [1, 0, 0] })).toThrow("spline points 0 and 1 coincide at (0, 0, 0)");
  expect(() => splineEdge([[0, 0, 0], [5, 0, 0]], { startTangent: [0, 0, 0] })).toThrow("startTangent must be a non-zero direction");
  expect(() => splineEdge(ring(4, 5), { closed: true, startTangent: [1, 0, 0] })).toThrow("closed spline is smooth at its seam");
  expect(() => splineEdge([[0, 0, 0], [5, 0, 0]], { closed: true })).toThrow("closed spline needs at least 3");
  expect(() => splineEdge([[0, 0, 0], [5, 0, 0]], { tangents: [null] })).toThrow("one entry (or null) per point");
  const poles: Vec3[] = [[0, 0, 0], [5, 5, 0], [10, 0, 0]];
  expect(() => bsplineEdge({ poles, degree: 3 })).toThrow("degree-3 bspline needs at least 4 control points (got 3)");
  expect(() => bsplineEdge({ poles, weights: [1, 0, 1] })).toThrow("weight 1 must be positive");
  expect(() => bsplineEdge({ poles, weights: [1, 1] })).toThrow("one weight per control point");
  expect(() => bsplineEdge({ poles, degree: 2, knots: [0, 1], mults: [3, 2] })).toThrow("sum(mults) = control points + degree + 1 (5 ≠ 3 + 2 + 1)");
  expect(() => bsplineEdge({ poles, degree: 2, knots: [0, 0, 0, 1, 0.5, 1] })).toThrow("non-decreasing");
  expect(() => bsplineEdge({ poles, degree: 2, knots: [1, 0], mults: [3, 3] })).toThrow("increasing");
  expect(() => bsplineEdge({ poles, degree: 1.5 })).toThrow("integer from 1 to 25");
});
