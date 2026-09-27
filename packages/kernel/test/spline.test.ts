import { beforeAll, expect, test } from "bun:test";
import { loadKernel, splineEdge, edgeInfo } from "../src";
beforeAll(async () => { await loadKernel(); });
test("spline edge through points", () => {
  const e = splineEdge([[0, 0, 0], [10, 5, 0], [20, 0, 0]]);
  expect(edgeInfo(e).curve).toBe("bspline");
  expect(edgeInfo(e).length).toBeGreaterThan(20);
});
