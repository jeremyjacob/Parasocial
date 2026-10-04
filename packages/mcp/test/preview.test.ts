// Session previews and assembly poses for MCP (no database, no engine pool: the runtime engine in-process).
import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadKernel } from "@parasocial/kernel";
import { Engine } from "@parasocial/runtime";
import { mergeOverrides, solveAssemblies, jointValues, scopedJointValues, poseTarget, expandTargets, targetNames, closeMatches, posedBox, emptyPreview, findAssembly } from "../src/preview";
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

test("close matches for unknown ids: case, last segment, substring, typos, then parents", () => {
  const { e, infos } = hinge();
  const names = targetNames(e.parts(), infos);
  expect(names).toEqual(["box", "box:lid", "box:drawer", "mechanism", "Hinged box", "mechanism/box", "mechanism/box:lid", "mechanism/box:drawer"]);
  expect(closeMatches("Box:LID", names)).toEqual(["box:lid", "mechanism/box:lid", "box"]);
  expect(closeMatches("drawer", names)).toEqual(["box:drawer", "mechanism/box:drawer"]);
  expect(closeMatches("hinged", names)).toEqual(["Hinged box"]);
  expect(closeMatches("mechanism/box:lld", names)).toEqual(["mechanism/box:lid", "box:lid", "mechanism/box", "mechanism", "box"]);
  expect(closeMatches("mechansim", names)).toEqual(["mechanism"]);
  expect(closeMatches("zz", names)).toEqual([]);
  expect(closeMatches("box", ["box:a", "box:b", "box:c", "box:d"], 2)).toEqual(["box:a", "box:b"]);
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

// a winch lying down, stood up by placing its frame: a motor fastened on top, a drive subassembly
const WINCH = {
  "studios/parts.ts": `import { part, box, cylinder } from "parasocial";
export const frame = part("Frame", () => box(100, 60, 10, { center: "xy" }));
export const motor = part("Motor", () => box(20, 20, 20, { center: "xy" }).translate([30, 0, 10]));
export const gearbox = part("Gearbox", () => box(20, 20, 20, { center: "xy" }).translate([-40, 0, 10]).connector("out", { origin: [-40, 0, 40], axis: "Z" }));
export const shaft = part("Shaft", () => cylinder(3, 20, { at: [-40, 0, 30] }));
`,
  "studios/winch_assembly.ts": `import { assembly } from "parasocial";
import { gearbox, shaft } from "./parts";
export const drive = assembly("Drive", ({ fix, revolute }) => {
  fix(gearbox);
  revolute(gearbox, shaft, gearbox.at("out"), { name: "Drum rotation" });
});
`,
  "studios/winch.ts": `import { assembly } from "parasocial";
import { frame, motor, gearbox } from "./parts";
import { drive } from "./winch_assembly";
export default assembly("Winch", ({ insert, fastened }) => {
  insert(frame, { place: { rotate: { axis: "X", angle: 90 } } });
  fastened(frame, motor);
  fastened(frame, insert(drive, { name: "upright" }).part(gearbox));
});
`,
};

test("a placed root carries its assembly for MCP too; scoped joint names are hinted", () => {
  const e = new Engine();
  e.setDocument({ scripts: WINCH });
  const results = Object.fromEntries(e.parts().map((p) => [p, e.regenerate(p)]));
  const infos = e.assemblies();
  const a = findAssembly(infos, "Winch")!;
  const { poses, assemblies } = solveAssemblies(infos, (p) => results[p], {}, { winch: { "winch_assembly:drive@upright/Drum rotation": [90] } });
  expect(assemblies.find((x) => x.id === "winch")!.problems).toEqual([]);
  // a quarter turn about X: (x, y, z) -> (x, -z, y)
  const up = (p: number[]) => [p[0], -p[2], p[1]];
  const at = (id: string, p: number[]) => {
    const { r, t } = poses[id];
    return [0, 1, 2].map((i) => r[i * 3] * p[0] + r[i * 3 + 1] * p[1] + r[i * 3 + 2] * p[2] + t[i]);
  };
  const close = (p: number[], q: number[]) => p.forEach((v, i) => expect(v).toBeCloseTo(q[i], 6));
  close(at("winch/parts:motor", [30, 0, 20]), up([30, 0, 20]));
  close(at("winch/winch_assembly:drive@upright/parts:gearbox", [-40, 0, 20]), up([-40, 0, 20]));
  // the shaft turned a quarter about its (carried) axis
  close(at("winch/winch_assembly:drive@upright/parts:shaft", [-40, 0, 40]), up([-40, 0, 40]));
  close(at("winch/winch_assembly:drive@upright/parts:shaft", [-37, 0, 40]), up([-40, 3, 40]));
  expect(() => jointValues(a, { "Drum rotation": 10 })).toThrow(/No movable joint "Drum rotation" in assembly winch\. Did you mean "winch_assembly:drive@upright\/Drum rotation"\? Joints in an inserted assembly are named "<its assembly id>@<insert name>\/<joint>"/);
  // render targets: the assembly, and an instance inside its subassembly
  expect(expandTargets(["winch"], e.parts(), infos).ids).toHaveLength(4);
  expect(expandTargets(["winch/winch_assembly:drive@upright/parts:shaft"], e.parts(), infos)).toEqual({ ids: ["winch/winch_assembly:drive@upright/parts:shaft"], unknown: [] });
  const sub = "winch/winch_assembly:drive@upright";
  const members = [`${sub}/parts:gearbox`, `${sub}/parts:shaft`];
  expect(expandTargets([sub, members[1]], e.parts(), infos)).toEqual({ ids: members, unknown: [] });
  expect(expandTargets([`${sub}2`], e.parts(), infos).unknown).toEqual([`${sub}2`]);
  expect(assemblies.find((x) => x.id === "winch")?.subassemblies).toEqual([{ id: sub, parent: "winch", assembly: "winch_assembly:drive", name: "Drive upright", instances: members }]);
  const target = poseTarget(infos, sub)!;
  expect(scopedJointValues(target, { "Drum rotation": 45 })).toEqual({ "winch_assembly:drive@upright/Drum rotation": [45] });
  expect(() => scopedJointValues(target, { "parts:frame+parts:motor": 45 })).toThrow(/No movable joint/);
});
