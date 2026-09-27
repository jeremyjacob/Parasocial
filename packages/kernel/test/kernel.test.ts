import { beforeAll, expect, test } from "bun:test";
import { loadKernel, lineEdge, wireFromEdges, faceFromWires, prism, topology, collectHistory, fillet, boolean, cylinder, faceInfo, edgeInfo, massProps, tessellate, circleEdge, arcEdge3, isValid, scoped } from "../src";

beforeAll(async () => { await loadKernel(); });

function rectFace(w: number, h: number) {
  const p = [[0,0,0],[w,0,0],[w,h,0],[0,h,0]] as [number,number,number][];
  const edges = p.map((a, i) => lineEdge(a, p[(i + 1) % 4]));
  return { edges, face: faceFromWires(wireFromEdges(edges)).shape };
}

test("prism history: side faces generated from profile edges, caps", () => {
  const { edges, face } = rectFace(40, 25);
  const pr = prism(face, [0, 0, 3]);
  const profileTopo = topology(face);
  const out = topology(pr.shape);
  const h = collectHistory(pr.maker, [profileTopo], out);
  expect(out.faces.size).toBe(6);
  const gen = h.face.filter((o) => o.some((x) => x.rel === "generated" && x.kind === "edge"));
  expect(gen.length).toBe(4);
  // caps: bottom face is "same" or generated from the profile face
  expect(h.face.filter((o) => o.some((x) => x.kind === "face")).length).toBe(1); // start cap is the profile itself
  const capStart = out.faces.indexOf(pr.caps!.start.Oriented ? pr.caps!.start : pr.caps!.start);
  const capEnd = out.faces.indexOf(pr.caps!.end);
  expect(capStart).toBeGreaterThanOrEqual(0);
  expect(capEnd).toBeGreaterThanOrEqual(0);
  expect(capStart).not.toBe(capEnd);
  const infos = out.faces.items.map(faceInfo);
  expect(infos.filter((i) => i.surface === "plane").length).toBe(6);
  const bottom = infos.find((i) => Math.abs(i.center[2]) < 1e-9)!;
  expect(bottom.normal[2]).toBeCloseTo(-1);
  expect(massProps(pr.shape).volume).toBeCloseTo(40 * 25 * 3, 6);
});

test("fillet + boolean history", () => {
  const { face } = rectFace(40, 25);
  const pr = prism(face, [0, 0, 10]);
  const t = topology(pr.shape);
  const vertical = t.edges.items.filter((e) => { const i = edgeInfo(e); return i.direction && Math.abs(i.direction[2]) > 0.99; });
  expect(vertical.length).toBe(4);
  const f = fillet(pr.shape, vertical, 2);
  const ft = topology(f.shape);
  const fh = collectHistory(f.maker, [t], ft);
  expect(ft.faces.size).toBe(10);
  const filletFaces = fh.face.filter((o) => o.some((x) => x.rel === "generated" && x.kind === "edge"));
  expect(filletFaces.length).toBe(4);
  expect(fh.face.filter((o) => o.length === 0).length).toBe(0);
  const cyl = cylinder(4, 20, [20, 12.5, -5]);
  const cut = boolean("subtract", f.shape, cyl.shape);
  const ct = topology(cut.shape);
  const ch = collectHistory(cut.maker, [ft, topology(cyl.shape)], ct);
  expect(ct.faces.size).toBe(11);
  const fromTool = ch.face.filter((o) => o.some((x) => x.slot === 1));
  expect(fromTool.length).toBe(1);
  expect(faceInfo(ct.faces.items[ch.face.indexOf(fromTool[0])]).surface).toBe("cylinder");
  expect(isValid(cut.shape)).toBe(true);
});

test("circle and arc edges; tessellation groups map to faces/edges", () => {
  const c = circleEdge([0, 0, 0], [0, 0, 1], 5);
  expect(edgeInfo(c).radius).toBeCloseTo(5);
  const a = arcEdge3([5, 0, 0], [0, 5, 0], [-5, 0, 0]);
  expect(edgeInfo(a).length).toBeCloseTo(Math.PI * 5, 4);
  const { face } = rectFace(10, 10);
  const pr = prism(face, [0, 0, 10]);
  const t = topology(pr.shape);
  const m = tessellate(pr.shape, t.faces, t.edges, 0.01, 0.3);
  for (let i = 0; i < t.faces.size; i++) expect(m.faceRanges[i * 2 + 1]).toBeGreaterThan(0);
  for (let i = 0; i < t.edges.size; i++) expect(m.edgeRanges[i * 2 + 1]).toBeGreaterThan(0);
  expect(m.indices.length).toBe(36);
});

test("STEP and STL export", async () => {
  const { exportSTEP, exportSTL } = await import("../src/io");
  const { face } = rectFace(10, 10);
  const pr = prism(face, [0, 0, 5]);
  const step = new TextDecoder().decode(exportSTEP(pr.shape));
  expect(step.startsWith("ISO-10303-21")).toBe(true);
  const stl = exportSTL(pr.shape);
  expect(stl.byteLength).toBeGreaterThan(84);
});
