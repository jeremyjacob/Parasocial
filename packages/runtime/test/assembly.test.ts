import { beforeAll, expect, test } from "bun:test";
import { loadKernel } from "@parasocial/kernel";
import { Engine } from "../src";

beforeAll(async () => {
  await loadKernel();
});

const BOX = `import { part, box } from "parasocial";
export const name = "Box";
export default part("Base", () => box(40, 40, 10, { center: "xy" }).connector("hinge", { origin: [0, 20, 10], axis: "X" }));
export const lid = part("Lid", () => {
  const plate = box(40, 40, 4, { center: "xy" }).translate([0, 0, 10]);
  return plate.connector("edge", plate.faces(">Y"));
});
`;
const ASM = `import { assembly } from "parasocial";
import base, { lid } from "./box";
export default assembly("Box", ({ revolute }) => {
  revolute(base, lid, base.at("hinge"), { min: -120, max: 0, name: "hinge" });
});
`;

test("assemblies are discovered and resolve to part ids", () => {
  const e = new Engine();
  e.setDocument({ scripts: { "studios/box.ts": BOX, "studios/mech.ts": ASM } });
  // a studio that only exports an assembly has no placeholder part
  expect(e.parts()).toEqual(["box", "box:lid"]);
  const [a] = e.assemblies();
  expect(a.id).toBe("mech");
  expect(a.problems).toEqual([]);
  expect(a.joints).toEqual([
    { name: "hinge", type: "revolute", a: "box", b: "box:lid", at: { part: "box", connector: "hinge" }, limits: [{ min: -120, max: 0 }], value: [0], overlap: false, source: { file: "studios/mech.ts", line: 4, col: expect.any(Number) } },
  ]);
});

test("connectors come back with regeneration, moved with their solid", () => {
  const e = new Engine();
  e.setDocument({ scripts: { "studios/box.ts": BOX } });
  expect(e.regenerate("box").connectors?.hinge).toEqual({ origin: [0, 20, 10], z: [1, 0, 0], x: [0, 1, 0] });
  const edge = e.regenerate("box:lid").connectors!.edge;
  expect(edge.origin[1]).toBeCloseTo(20, 6);
  expect(edge.origin[2]).toBeCloseTo(12, 6);
  expect(edge.z[1]).toBeCloseTo(1, 6);
});

test("bad joints become problems with a source line", () => {
  const e = new Engine();
  e.setDocument({ scripts: { "studios/box.ts": BOX, "studios/mech.ts": ASM.replace('base.at("hinge")', "42") } });
  const [a] = e.assemblies();
  expect(a.problems[0].message).toContain("connector");
  expect(a.problems[0].source?.line).toBe(4);
});

test("interference follows poses; touching isn't overlap", () => {
  const e = new Engine();
  e.setDocument({ scripts: { "studios/box.ts": BOX } });
  e.regenerate("box");
  e.regenerate("box:lid");
  // the lid sits on the base: faces touch, nothing overlaps
  expect(e.interferences(["box", "box:lid"])).toEqual([]);
  // push the lid 3 mm down into the base
  e.setPoses({ "box:lid": { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, -3] } });
  const [hit] = e.interferences(["box", "box:lid"]);
  expect(hit.a).toBe("box");
  expect(hit.b).toBe("box:lid");
  expect(hit.volume).toBeCloseTo(40 * 40 * 3, 3);
  expect(hit.mesh!.indices.length).toBeGreaterThan(0);
  expect(e.interferences(["box", "box:lid"], [["box:lid", "box"]])).toEqual([]);
  // measuring sees the pose too
  expect(e.measure({ part: "box", kind: "part" }, { part: "box:lid", kind: "part" }).distance).toBeCloseTo(0, 6);
});

test("the hinged box example: joints resolve, nothing overlaps closed, the drawer collides if pushed in", async () => {
  const { Glob } = await import("bun");
  const { join } = await import("node:path");
  const { readFileSync } = await import("node:fs");
  const root = join(import.meta.dir, "../../../examples/hinge");
  const scripts: Record<string, string> = {};
  for (const f of new Glob("studios/*.ts").scanSync(root)) scripts[f] = readFileSync(join(root, f), "utf8");
  const e = new Engine();
  e.setDocument({ scripts });
  expect(e.parts()).toEqual(["box", "box:lid", "box:drawer"]);
  for (const p of e.parts()) expect(e.regenerate(p).ok).toBe(true);
  const [a] = e.assemblies();
  expect(a.problems).toEqual([]);
  expect(a.joints.map((j) => [j.name, j.type, j.a, j.b])).toEqual([
    ["lid", "revolute", "box", "box:lid"],
    ["drawer", "slider", "box", "box:drawer"],
  ]);
  expect(e.interferences(e.parts())).toEqual([]);
  e.setPoses({ "box:drawer": { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 2, 0] } });
  const hits = e.interferences(e.parts());
  expect(hits.map((h) => [h.a, h.b])).toEqual([["box", "box:drawer"]]);
});
