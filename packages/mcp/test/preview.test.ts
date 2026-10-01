// Session previews and assembly poses for MCP (no database, no engine pool: the runtime engine in-process).
import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadKernel } from "@parasocial/kernel";
import { Engine } from "@parasocial/runtime";
import { mergeOverrides, solveAssemblies, jointValues, expandTargets, posedBox, emptyPreview, findAssembly } from "../src/preview";
import { posed, type RenderPart } from "@parasocial/engine-pool/render";

const root = join(import.meta.dir, "../../../examples/hinge");
const scripts = { "studios/box.ts": readFileSync(join(root, "studios/box.ts"), "utf8"), "studios/mechanism.ts": readFileSync(join(root, "studios/mechanism.ts"), "utf8") };

beforeAll(async () => {
  await loadKernel();
});

function hinge() {
  const e = new Engine();
  e.setDocument({ scripts });
  const results = Object.fromEntries(e.parts().map((p) => [p, e.regenerate(p)]));
  const infos = e.assemblies();
  return { e, results, infos };
}

test("preview overrides layer over the configuration's", () => {
  const base = { box: { height: "50" }, "box:lid": { thickness: "4" } };
  expect(mergeOverrides(base, undefined)).toBe(base);
  expect(mergeOverrides(base, emptyPreview())).toBe(base);
  expect(mergeOverrides(base, { params: { box: { height: 60, bay: "12" }, "box:drawer": { bay: 9 } }, poses: {} })).toEqual({ box: { height: 60, bay: "12" }, "box:lid": { thickness: "4" }, "box:drawer": { bay: 9 } });
  // the configuration itself is untouched
  expect(base.box).toEqual({ height: "50" });
});

test("poses: shared values first, the session's on top; home when neither", () => {
  const { results, infos } = hinge();
  const meta = (p: string) => results[p];
  const home = solveAssemblies(infos, meta);
  expect(home.poses).toEqual({});
  const [a] = home.assemblies;
  expect(a.id).toBe("mechanism");
  expect(a.instances).toEqual(["mechanism/box", "mechanism/box:lid", "mechanism/box:drawer"]);
  expect(a.joints.map((j) => [j.name, j.value, j.units, j.from])).toEqual([
    ["lid", [0], ["deg"], "home"],
    ["drawer", [0], ["mm"], "home"],
  ]);

  // someone left the drawer open in the workspace
  const shared = { mechanism: { lid: [0], drawer: [30] } };
  const s1 = solveAssemblies(infos, meta, shared);
  expect(s1.poses["mechanism/box:drawer"].t.map((v) => +v.toFixed(6))).toEqual([0, -30, 0]);
  expect(s1.poses["mechanism/box:lid"]).toBeUndefined();

  // this session opens the lid: the drawer stays where it's shared
  const s2 = solveAssemblies(infos, meta, shared, { mechanism: { lid: [90] } });
  expect(s2.assemblies[0].joints.map((j) => [j.name, j.value[0], j.from])).toEqual([
    ["lid", 90, "session"],
    ["drawer", 30, "shared"],
  ]);
  const lid = s2.poses["mechanism/box:lid"];
  // the lid turns 90° about the back top edge (axis -X at y = 25, z = 40): its far edge stands up
  const bb = posedBox(results["box:lid"].bbox!, lid);
  expect(bb.min[1]).toBeGreaterThan(20);
  expect(bb.max[2]).toBeGreaterThan(80);
  expect(s2.poses["mechanism/box:drawer"].t[1]).toBeCloseTo(-30, 6);

  // limits clamp
  const s3 = solveAssemblies(infos, meta, {}, { mechanism: { lid: [500] } });
  expect(s3.assemblies[0].joints[0].value).toEqual([110]);
});

test("joint values are checked against the assembly", () => {
  const { infos } = hinge();
  const a = findAssembly(infos, "Hinged box")!;
  expect(a.id).toBe("mechanism");
  expect(jointValues(a, { lid: 45, drawer: [10] })).toEqual({ lid: [45], drawer: [10] });
  expect(() => jointValues(a, { hinge: 45 })).toThrow(/No movable joint "hinge".*lid \(revolute: deg\); drawer \(slider: mm\)/);
  expect(() => jointValues(a, { lid: [1, 2] })).toThrow(/revolute: give 1 number/);
});

test("render targets: parts, instances and whole assemblies", () => {
  const { e, infos } = hinge();
  const parts = e.parts();
  expect(expandTargets(["box:lid", "mechanism/box:lid"], parts, infos)).toEqual({ ids: ["box:lid", "mechanism/box:lid"], unknown: [] });
  expect(expandTargets(["mechanism"], parts, infos).ids).toEqual(["mechanism/box", "mechanism/box:lid", "mechanism/box:drawer"]);
  expect(expandTargets(["Hinged box", "mechanism/box"], parts, infos).ids).toEqual(["mechanism/box", "mechanism/box:lid", "mechanism/box:drawer"]);
  expect(expandTargets(["nope", "mechanism/box:nope"], parts, infos).unknown).toEqual(["nope", "mechanism/box:nope"]);
});

test("instance meshes move with their pose for renders", () => {
  const { results, infos } = hinge();
  const { poses } = solveAssemblies(infos, (p) => results[p], {}, { mechanism: { lid: [90] } });
  const r = results["box:lid"] as unknown as RenderPart;
  const moved = posed(r, poses["mechanism/box:lid"]);
  expect(posed(r, undefined)).toBe(r);
  const z = (m: RenderPart) => {
    let max = -Infinity;
    for (let i = 2; i < m.mesh.positions.length; i += 3) max = Math.max(max, m.mesh.positions[i]);
    return max;
  };
  expect(z(r)).toBeCloseTo(43, 3);
  expect(z(moved)).toBeGreaterThan(80);
  // normals rotate (unit length kept), edges move with the faces
  const n = moved.mesh.normals;
  expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 5);
  expect(moved.mesh.edgePositions.length).toBe(r.mesh.edgePositions.length);
  expect(Math.max(...moved.mesh.edgePositions.filter((_, i) => i % 3 === 2))).toBeCloseTo(z(moved), 3);
});
