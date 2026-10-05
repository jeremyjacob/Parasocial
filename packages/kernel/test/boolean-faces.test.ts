import { beforeAll, expect, test } from "bun:test";
import { loadKernel, box, booleanMany, collectHistory, deleteTopology, faceInfo, isValid, massProps, tessellate, topology } from "../src";

beforeAll(async () => { await loadKernel(); });

test("boolean unions produce whole CAD faces with history and complete pick ranges", () => {
  const inputs = [box(20, 20, 4), box(10, 20, 4, [15, 0, 0]), box(10, 20, 4, [20, 0, 0])];
  const inputTopos = inputs.map((b) => topology(b.shape));
  const built = booleanMany("union", inputs[0].shape, inputs.slice(1).map((b) => b.shape));
  const out = topology(built.shape);
  try {
    expect(isValid(built.shape)).toBe(true);
    expect(massProps(built.shape).volume).toBeCloseTo(30 * 20 * 4, 6);
    expect(out.faces.size).toBe(6);
    expect(out.edges.size).toBe(12);

    const faces = out.faces.items.map(faceInfo);
    const top = faces.findIndex((f) => f.normal[2] > 0.99);
    expect(faces[top].area).toBeCloseTo(30 * 20, 6);
    const history = collectHistory(built.maker, inputTopos, out);
    expect(history.face.every((origins) => origins.length > 0)).toBe(true);
    for (let slot = 0; slot < inputs.length; slot++) {
      const index = inputTopos[slot].faces.items.findIndex((f) => faceInfo(f).normal[2] > 0.99);
      expect(history.face[top]).toContainEqual({ slot, kind: "face", index, rel: "modified" });
    }

    // The viewer picks and paints this range as one face, across all three original boxes.
    const mesh = tessellate(built.shape, out.faces, out.edges, 0.01, 0.3);
    const start = mesh.faceRanges[top * 2], count = mesh.faceRanges[top * 2 + 1];
    let area = 0;
    for (let i = start; i < start + count; i += 3) {
      const [a, b, c] = Array.from(mesh.indices.subarray(i, i + 3), (v) => v * 3);
      const p = mesh.positions;
      area += Math.abs((p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a])) / 2;
    }
    expect(area).toBeCloseTo(30 * 20, 6);
  } finally {
    deleteTopology(out);
    built.maker?.delete();
    built.shape.delete();
    inputTopos.forEach(deleteTopology);
    inputs.forEach((b) => { b.maker?.delete(); b.shape.delete(); });
  }
});
