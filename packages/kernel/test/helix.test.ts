import { beforeAll, expect, test } from "bun:test";
import { loadKernel, helixEdge, helixEdges, edgeInfo, sweep, wireFromEdges, lineEdge, circleEdge, faceFromWires, isValid, massProps, explore, vertexPoint, KernelError, shapeKind } from "../src";

beforeAll(async () => {
  await loadKernel();
});

const close = (a: number[], b: number[], tol = 1e-6) => a.forEach((x, i) => expect(Math.abs(x - b[i])).toBeLessThan(tol));

test("helix edge: length and end points", () => {
  const r = 5, pitch = 2, turns = 3;
  const info = edgeInfo(helixEdge({ radius: r, pitch, turns }));
  expect(info.length).toBeCloseTo(turns * Math.hypot(2 * Math.PI * r, pitch), 4);
  close(info.start, [5, 0, 0]);
  close(info.end, [5, 0, 6]);
  close(info.mid, [-5, 0, 3]);
  // quarter turn past: right-handed goes +x -> +y
  close(edgeInfo(helixEdge({ radius: r, pitch, height: 2.5 })).end, [0, 5, 2.5]);
  close(edgeInfo(helixEdge({ radius: r, pitch, height: 0.5, leftHanded: true })).end, [0, -5, 0.5]);
});

test("helix edge: axis, origin, taper", () => {
  const e = edgeInfo(helixEdge({ radius: 2, pitch: 1, turns: 2, origin: [1, 1, 1], axis: [1, 0, 0] }));
  close(e.start, [1, 3, 1]);
  close(e.end, [3, 3, 1]);
  const t = edgeInfo(helixEdge({ radius: 2, pitch: 1, turns: 2, taper: Math.atan(0.1) }));
  close(t.start, [2, 0, 0]);
  close(t.end, [2 + 0.2, 0, 2], 1e-5);
});

test("helixEdges: half-turn pieces that join end to end", () => {
  const es = helixEdges({ radius: 5, pitch: 2, turns: 3.25 });
  expect(es.length).toBe(7);
  const infos = es.map(edgeInfo);
  close(infos[0].start, [5, 0, 0]);
  close(infos[6].end, [0, 5, 6.5], 1e-5);
  for (let i = 1; i < infos.length; i++) close(infos[i].start, infos[i - 1].end, 1e-6);
  const total = infos.reduce((s, e) => s + e.length, 0);
  expect(total).toBeCloseTo(3.25 * Math.hypot(2 * Math.PI * 5, 2), 4);
  expect(isValid(wireFromEdges(es))).toBe(true);
});

test("helix edge: errors", () => {
  expect(() => helixEdge({ radius: 0, pitch: 1, turns: 1 })).toThrow(/radius must be positive/);
  expect(() => helixEdge({ radius: 1, pitch: -1, turns: 1 })).toThrow(/pitch must be positive/);
  expect(() => helixEdge({ radius: 1, pitch: 1, height: 0 })).toThrow(/height must be positive/);
  expect(() => helixEdge({ radius: 1, pitch: 1 })).toThrow(KernelError);
});

test("sweep along helix with a fixed binormal keeps a thread profile upright", () => {
  // 2.25 turns: the end cap sits a quarter turn round, at z = 4.5
  const path = wireFromEdges([helixEdge({ radius: 5, pitch: 2, turns: 2.25 })]);
  const tri = faceFromWires(wireFromEdges([lineEdge([5, 0, -0.8], [6, 0, 0]), lineEdge([6, 0, 0], [5, 0, 0.8]), lineEdge([5, 0, 0.8], [5, 0, -0.8])])).shape;
  const b = sweep(tri, path, { mode: { binormal: [0, 0, 1] } });
  expect(shapeKind(b.shape)).toBe("solid");
  expect(isValid(b.shape)).toBe(true);
  const end = explore(b.caps!.end, "vertex").items.map(vertexPoint).sort((p, q) => p[2] - q[2]);
  close(end[0], [0, 5, 3.7], 1e-3);
  close(end[1], [0, 6, 4.5], 1e-3);
  close(end[2], [0, 5, 5.3], 1e-3);
  // the default (corrected Frenet) twists it
  const c = sweep(tri, path);
  const twisted = explore(c.caps!.end, "vertex").items.map(vertexPoint);
  expect(twisted.some((p) => Math.abs(p[0]) > 1e-2 || Math.abs(Math.hypot(p[0], p[1]) - 5) > 0.1 && Math.abs(Math.hypot(p[0], p[1]) - 6) > 0.1)).toBe(true);
  b.maker.delete();
  c.maker.delete();
});

test("sweep with a fixed binormal rejects faces with holes", () => {
  const path = wireFromEdges([helixEdge({ radius: 5, pitch: 3, turns: 1 })]);
  const ring = faceFromWires(wireFromEdges([circleEdge([5, 0, 0], [0, 1, 0], 1)]), [wireFromEdges([circleEdge([5, 0, 0], [0, 1, 0], 0.5)])]).shape;
  expect(() => sweep(ring, path, { mode: { binormal: [0, 0, 1] } })).toThrow(/holes/);
  void massProps;
});
