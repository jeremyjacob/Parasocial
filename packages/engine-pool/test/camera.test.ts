// Render cameras: framing some parts among others, and an explicit scale (camera.width).
import { expect, test } from "bun:test";
import { bounds, camera, type RenderPart } from "../src/render";

/** A part that is just a box's eight corners (bounds only read positions). */
const boxPart = (min: number[], max: number[]): RenderPart => {
  const positions = new Float32Array(24);
  for (let i = 0; i < 8; i++) positions.set([i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]], i * 3);
  return { mesh: { positions, normals: new Float32Array(24), indices: new Uint32Array(), faceRanges: new Uint32Array(), edgePositions: new Float32Array(), edgeRanges: new Uint32Array() }, faceEdges: [], edges: [] };
};

/** Column-major viewProj × point → NDC. */
const ndc = (m: Float32Array, p: number[]) => {
  const v = [0, 1, 2, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
  return [v[0] / v[3], v[1] / v[3], v[2] / v[3]];
};
const corners = (min: number[], max: number[]) => [...Array(8)].map((_, i) => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]]);

const housing = boxPart([-200, -200, -200], [200, 200, 200]);
const battery = boxPart([90, 40, -10], [130, 60, 30]);

for (const ortho of [false, true]) {
  test(`framing one part among others fills the image with it (${ortho ? "ortho" : "perspective"})`, () => {
    const scene = bounds([housing, battery]);
    const fit = bounds([battery]);
    const c = camera({ view: "iso", camera: ortho ? { position: [1, -1, 1], target: [0, 0, 0], up: [0, 0, 1], ortho } : undefined }, fit, 4 / 3, true, scene);
    const pts = corners(fit.min, fit.max).map((p) => ndc(c.viewProj, p));
    for (const [x, y] of pts) {
      expect(Math.abs(x)).toBeLessThanOrEqual(1);
      expect(Math.abs(y)).toBeLessThanOrEqual(1);
    }
    // a close-up: the part spans most of the image, not a speck in the housing's view
    const span = Math.max(Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1])));
    expect(span).toBeGreaterThan(1.2);
    // aimed at the framed part
    const center = ndc(c.viewProj, fit.center);
    expect(Math.abs(center[0])).toBeLessThan(0.2);
    expect(Math.abs(center[1])).toBeLessThan(0.2);
  });
}

test("camera.width sets mm across the image, ortho or perspective, whatever the distance", () => {
  const b = bounds([battery]);
  for (const ortho of [true, false])
    for (const dist of [50, 5000]) {
      const c = camera({ camera: { position: [0, -dist, 0], target: [0, 0, 0], up: [0, 0, 1], ortho, width: 80 } }, b, 2);
      // the target plane: x = ±40 mm reaches the image's left and right edges
      expect(ndc(c.viewProj, [40, 0, 0])[0]).toBeCloseTo(1, 4);
      expect(ndc(c.viewProj, [-40, 0, 0])[0]).toBeCloseTo(-1, 4);
      expect(ndc(c.viewProj, [0, 0, 20])[1]).toBeCloseTo(1, 4);
    }
});

test("an explicit camera without frame or width is unchanged", () => {
  const b = bounds([battery]);
  const c = camera({ camera: { position: [0, -300, 0], target: [10, 0, 0], up: [0, 0, 1] } }, b, 1);
  expect(c.eye).toEqual([0, -300, 0]);
  expect(Math.abs(ndc(c.viewProj, [10, 0, 0])[0])).toBeLessThan(1e-6);
});
