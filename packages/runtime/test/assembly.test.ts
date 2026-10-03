import { beforeAll, expect, test } from "bun:test";
import { loadKernel } from "@parasocial/kernel";
import { Engine, computeBom, bomToMarkdown } from "../src";
import { resolveAssembly } from "../src/mechanism";

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

test("assemblies are discovered, with their own instances of the parts", () => {
  const e = new Engine();
  e.setDocument({ scripts: { "studios/box.ts": BOX, "studios/mech.ts": ASM } });
  // a studio that only exports an assembly has no placeholder part
  expect(e.parts()).toEqual(["box", "box:lid"]);
  const [a] = e.assemblies();
  expect(a.id).toBe("mech");
  expect(a.problems).toEqual([]);
  expect(a.instances).toEqual([
    { id: "mech/box", part: "box", scope: "mech" },
    { id: "mech/box:lid", part: "box:lid", scope: "mech" },
  ]);
  expect(a.joints).toEqual([
    { name: "hinge", named: true, type: "revolute", a: "mech/box", b: "mech/box:lid", scope: "mech", at: { part: "box", connector: "hinge", owner: "mech/box" }, limits: [{ min: -120, max: 0 }], value: [0], overlap: false, source: { file: "studios/mech.ts", line: 4, col: expect.any(Number) } },
  ]);
});

test("instances share their source part's geometry; poses move the instance, never the source", () => {
  const e = new Engine();
  e.setDocument({ scripts: { "studios/box.ts": BOX, "studios/mech.ts": ASM } });
  e.regenerate("box");
  e.regenerate("box:lid");
  const r = e.regenerate("mech/box:lid");
  expect(r.part).toBe("mech/box:lid");
  expect(r.name).toBe("Lid");
  expect(e.query("mech/box:lid", ">Z")).toEqual(e.query("box:lid", ">Z"));
  // push the instance of the lid 3 mm down into the base's instance
  e.setPoses({ "mech/box:lid": { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, -3] } });
  expect(e.interferences(["mech/box", "mech/box:lid"]).map((h) => [h.a, h.b])).toEqual([["mech/box", "mech/box:lid"]]);
  expect(e.interferences(["box", "box:lid"])).toEqual([]);
  expect(e.measure({ part: "box", kind: "part" }, { part: "box:lid", kind: "part" }).distance).toBeCloseTo(0, 6);
});

test("connectors come back with regeneration, moved with their solid", () => {
  const e = new Engine();
  e.setDocument({ scripts: { "studios/box.ts": BOX } });
  expect(e.regenerate("box").connectors?.hinge).toEqual([{ origin: [0, 20, 10], z: [1, 0, 0], x: [0, 1, 0] }]);
  const [edge] = e.regenerate("box:lid").connectors!.edge;
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
    ["lid", "revolute", "mechanism/box", "mechanism/box:lid"],
    ["drawer", "slider", "mechanism/box", "mechanism/box:drawer"],
  ]);
  const ids = a.instances.map((i) => i.id);
  expect(e.interferences(ids)).toEqual([]);
  e.setPoses({ "mechanism/box:drawer": { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 2, 0] } });
  const hits = e.interferences(ids);
  expect(hits.map((h) => [h.a, h.b])).toEqual([["mechanism/box", "mechanism/box:drawer"]]);
});

test("the desk lamp example: two parallelogram loops, 4 DOF, collision-free across its limits", async () => {
  const { Glob } = await import("bun");
  const { join } = await import("node:path");
  const { readFileSync } = await import("node:fs");
  const { Mechanism } = await import("@parasocial/assembly");
  const root = join(import.meta.dir, "../../../examples/lamp");
  const scripts: Record<string, string> = {};
  for (const f of new Glob("studios/*.ts").scanSync(root)) scripts[f] = readFileSync(join(root, f), "utf8");
  const e = new Engine();
  e.setDocument({ scripts });
  expect(e.parts()).toEqual(["lamp", "lamp:turret", "lamp:lowerArm", "lamp:lowerRod", "lamp:elbow", "lamp:upperArm", "lamp:upperRod", "lamp:wrist", "lamp:shade", "lamp:bulb"]);
  const results = Object.fromEntries(e.parts().map((p) => [p, e.regenerate(p)]));
  for (const p of e.parts()) expect([p, results[p].ok]).toEqual([p, true]);
  const [a] = e.assemblies();
  expect(a.problems).toEqual([]);
  expect(a.fixed).toEqual(["mechanism/lamp"]);
  const ids = a.instances.map((i) => i.id);
  expect(a.instances.map((i) => i.part).sort()).toEqual([...e.parts()].sort());
  expect(e.interferences(ids)).toEqual([]);

  // the solver, built the way the app builds it: connector frames from the regenerated parts
  const { spec, problems } = resolveAssembly(a, (p) => results[p].connectors ?? {});
  expect(problems).toEqual([]);
  const mech = new Mechanism({ ...spec, scale: 200 });
  expect(mech.error()).toBeLessThan(1e-9);
  // 10 revolutes, two planar loops each taking 3: swivel, shoulder, elbow, tilt
  expect(mech.dof()).toBe(4);
  expect(mech.movable("mechanism/lamp:shade")).toBe(true);
  expect(mech.movable("mechanism/lamp:bulb")).toBe(true);
  expect(mech.movable("mechanism/lamp")).toBe(false);

  const collisions = () => {
    const poses: Record<string, { r: number[]; t: [number, number, number] }> = {};
    for (const [p, T] of mech.poses()) poses[p] = { r: [...T.r], t: [T.t[0], T.t[1], T.t[2]] };
    e.setPoses(poses);
    return e.interferences(ids).map((h) => [h.a, h.b]);
  };
  const level = (p: string) => mech.poses().get(p)!.r[8]; // z stays z: the knuckle hasn't tipped

  // drag the shade around: the loops stay closed, the knuckles stay level, nothing collides
  const grab: [number, number, number] = [344, 0, 200];
  for (const target of [[300, 0, 300], [250, 0, 350], [200, 100, 250], [380, 0, 150]] as [number, number, number][]) {
    for (let i = 0; i < 30; i++) mech.drag("mechanism/lamp:shade", grab, target);
    expect(mech.error()).toBeLessThan(1e-6);
    const p = mech.pointAt("mechanism/lamp:shade", grab);
    expect(Math.hypot(p[0] - target[0], p[1] - target[1], p[2] - target[2])).toBeLessThan(1);
    const v = mech.values();
    expect(v["shoulder rod"][0]).toBeCloseTo(v.shoulder[0], 5);
    expect(v["elbow rod"][0]).toBeCloseTo(v.elbow[0], 5);
    expect(level("mechanism/lamp:elbow")).toBeCloseTo(1, 9);
    expect(level("mechanism/lamp:wrist")).toBeCloseTo(1, 9);
    expect(collisions()).toEqual([]);
  }

  // every corner of the limits is collision-free
  const lim = (name: string) => a.joints.find((j) => j.name === name)!.limits[0]!;
  for (const sh of [lim("shoulder").min!, lim("shoulder").max!])
    for (const el of [lim("elbow").min!, lim("elbow").max!])
      for (const ti of [lim("tilt").min!, lim("tilt").max!]) {
        const err = mech.setValues({ swivel: [90], shoulder: [sh], "shoulder rod": [sh], "elbow pin": [-sh], "elbow rod pin": [-sh], elbow: [el], "elbow rod": [el], "wrist pin": [-el], "wrist rod pin": [-el], tilt: [ti] });
        expect(err).toBeLessThan(1e-6);
        expect([sh, el, ti, collisions()]).toEqual([sh, el, ti, []]);
      }
});

test("interference skips a part that failed to regenerate instead of throwing", () => {
  const e = new Engine();
  e.setDocument({ scripts: { "studios/box.ts": BOX } });
  e.regenerate("box");
  e.regenerate("box:lid");
  e.setScript("studios/box.ts", BOX.replace("box(40, 40, 4", "box(40, 40, -4"));
  e.regenerate("box:lid");
  expect(() => e.interferences(["box", "box:lid"])).not.toThrow();
});

test("the lamp's arm lengths are shared params: the loops close at any length", async () => {
  const { Glob } = await import("bun");
  const { join } = await import("node:path");
  const { readFileSync } = await import("node:fs");
  const { Mechanism } = await import("@parasocial/assembly");
  const root = join(import.meta.dir, "../../../examples/lamp");
  const scripts: Record<string, string> = {};
  for (const f of new Glob("studios/*.ts").scanSync(root)) scripts[f] = readFileSync(join(root, f), "utf8");
  const e = new Engine();
  e.setDocument({ scripts, overrides: { "*": { lowerArm: 235, upperArm: 175 } } });
  const results = Object.fromEntries(e.parts().map((p) => [p, e.regenerate(p)]));
  for (const p of e.parts()) expect([p, results[p].ok]).toEqual([p, true]);
  expect(results["lamp:lowerArm"].params.find((d) => d.name === "lowerArm")).toMatchObject({ shared: true, overridden: true, value: 235 });
  const [a] = e.assemblies();
  const { spec, problems } = resolveAssembly(a, (p) => results[p].connectors ?? {});
  expect(problems).toEqual([]);
  const mech = new Mechanism({ ...spec, scale: 200 });
  expect(mech.error()).toBeLessThan(1e-9);
  expect(mech.dof()).toBe(4);
  expect(mech.drivers()).toEqual(["swivel", "shoulder", "elbow", "tilt"]);
});

test("a studio can't export both parts and an assembly", () => {
  const e = new Engine();
  const mixed = `import { assembly, part, box } from "parasocial";
export const base = part("Base", () => box(10, 10, 10).connector("top", { origin: [0, 0, 10], axis: "Z" }));
export const lid = part("Lid", () => box(10, 10, 2).translate([0, 0, 10]));
export const mech = assembly("Box", ({ revolute }) => revolute(base, lid, base.at("top")));
`;
  e.setDocument({ scripts: { "studios/box.ts": mixed } });
  // the parts stay usable; the assembly reports the mix and holds no instances
  expect(e.parts()).toEqual(["box:base", "box:lid"]);
  const [a] = e.assemblies();
  expect(a.instances).toEqual([]);
  expect(a.joints).toEqual([]);
  expect(a.problems.map((p) => p.message)).toEqual(['a studio exports parts or assemblies, not both: move "Base", "Lid" to another studio and import them here']);
});

// ---------- copies, connector-to-connector joints, patterns, subassemblies ----------

// a plate with four holes (one connector frame per hole) and axles at its corners; a wheel and a bolt
const CART = `import { part, box, cylinder } from "parasocial";
export const name = "Cart";
export const chassis = part("Chassis", () => {
  let plate = box(100, 60, 10, { center: "xy" });
  for (const x of [-20, 20]) for (const y of [-10, 10]) plate = plate.cut(cylinder(3, 10, { at: [x, y, 0] }));
  return plate
    .connector("axle", [
      { origin: [40, 30, 5], axis: "Y" },
      { origin: [40, -30, 5], axis: [0, -1, 0] },
      { origin: [-40, 30, 5], axis: "Y" },
      { origin: [-40, -30, 5], axis: [0, -1, 0] },
    ])
    .connector("bolt", plate.faces().filter((f) => f.surface === "cylinder"));
});
export const wheel = part("Wheel", () => cylinder(15, 8).connector("hub", { origin: [0, 0, 0], axis: "Z" }));
export const bolt = part("Bolt", () => cylinder(2.5, 20).connector("head", { origin: [0, 0, 0], axis: [0, 0, -1] }));
`;
const regenAll = (e: Engine) => Object.fromEntries(e.parts().map((p) => [p, e.regenerate(p)]));
const posedPoint = (mech: InstanceType<typeof import("@parasocial/assembly").Mechanism>, id: string, p: [number, number, number]) => mech.pointAt(id, p);

test("insert makes named copies; connector-to-connector joints put each wheel on its axle", async () => {
  const { Mechanism } = await import("@parasocial/assembly");
  const e = new Engine();
  e.setDocument({
    scripts: {
      "studios/cart.ts": CART,
      "studios/assembly.ts": `import { assembly } from "parasocial";
import { chassis, wheel, bolt } from "./cart";
export default assembly("Cart", ({ insert, fix, revolute, fastened }) => {
  fix(chassis);
  ["fl", "fr", "rl", "rr"].forEach((corner, i) => revolute(chassis.at("axle", i), insert(wheel, { name: corner }).at("hub"), { name: corner }));
  for (let i = 0; i < 4; i++) fastened(chassis.at("bolt", i), insert(bolt, { name: String(i + 1) }).at("head"));
});
`,
    },
  });
  const results = regenAll(e);
  expect(results["cart:chassis"].connectors!.bolt).toHaveLength(4);
  const [a] = e.assemblies();
  expect(a.problems).toEqual([]);
  expect(a.instances.map((i) => i.id)).toEqual(["assembly/cart:chassis", "assembly/cart:wheel@fl", "assembly/cart:wheel@fr", "assembly/cart:wheel@rl", "assembly/cart:wheel@rr", "assembly/cart:bolt@1", "assembly/cart:bolt@2", "assembly/cart:bolt@3", "assembly/cart:bolt@4"]);
  expect(a.instances[1]).toEqual({ id: "assembly/cart:wheel@fl", part: "cart:wheel", scope: "assembly", name: "fl" });
  expect(a.joints.map((j) => j.name)).toEqual(["fl", "fr", "rl", "rr", "cart:chassis+cart:bolt@1", "cart:chassis+cart:bolt@2", "cart:chassis+cart:bolt@3", "cart:chassis+cart:bolt@4"]);
  expect(a.joints[0].at).toEqual({ mate: { a: { connector: "axle", index: 0 }, b: { connector: "hub" } }, flip: false });
  // copies regenerate as their part
  expect(e.regenerate("assembly/cart:wheel@rr").name).toBe("Wheel");

  const { spec, problems } = resolveAssembly(a, (p) => results[p].connectors ?? {});
  expect(problems).toEqual([]);
  const mech = new Mechanism({ ...spec, scale: 100 });
  expect(mech.error()).toBeLessThan(1e-9);
  expect(mech.dof()).toBe(4); // four wheels spin
  // the hub center sits on its axle, the wheel's axis along the axle (outward)
  const close = (p: number[], q: number[]) => p.forEach((v, i) => expect(v).toBeCloseTo(q[i], 6));
  close(posedPoint(mech, "assembly/cart:wheel@fr", [0, 0, 0]), [40, -30, 5]);
  close(posedPoint(mech, "assembly/cart:wheel@fr", [0, 0, 8]), [40, -38, 5]);
  close(posedPoint(mech, "assembly/cart:wheel@rl", [0, 0, 8]), [-40, 38, 5]);
  // each bolt goes down its hole, head at the hole's center
  const holes = results["cart:chassis"].connectors!.bolt.map((f) => f.origin);
  for (let i = 0; i < 4; i++) {
    close(posedPoint(mech, `assembly/cart:bolt@${i + 1}`, [0, 0, 0]), holes[i]);
    // the head's z (-Z in the bolt) lines up with the hole's axis, so the shaft runs the other way along it
    const z = results["cart:chassis"].connectors!.bolt[i].z;
    close(posedPoint(mech, `assembly/cart:bolt@${i + 1}`, [0, 0, 20]).map((v, k) => v - holes[i][k]), z.map((v) => -20 * v));
  }
  expect(mech.movable("assembly/cart:wheel@fl")).toBe(true);
  expect(mech.movable("assembly/cart:bolt@1")).toBe(false);
});

test("an assembly can insert another: its parts keep their joints and move together", async () => {
  const { Mechanism } = await import("@parasocial/assembly");
  const e = new Engine();
  e.setDocument({
    scripts: {
      "studios/cart.ts": CART,
      // a wheel on a bolt as an axle: the wheel spins on it
      "studios/corner.ts": `import { assembly } from "parasocial";
import { wheel, bolt } from "./cart";
export default assembly("Corner", ({ fix, revolute }) => {
  fix(bolt);
  revolute(bolt.at("head"), wheel.at("hub"), { name: "spin" });
});
`,
      "studios/assembly.ts": `import { assembly } from "parasocial";
import { chassis, wheel, bolt } from "./cart";
import corner from "./corner";
export default assembly("Cart", ({ insert, fix, fastened }) => {
  fix(chassis);
  for (const [i, name] of ["left", "right"].entries()) {
    const c = insert(corner, { name });
    fastened(chassis.at("axle", i), c.part(bolt).at("head"));
  }
});
`,
    },
  });
  const results = regenAll(e);
  const all = e.assemblies();
  const a = all.find((x) => x.id === "assembly")!;
  expect(a.problems).toEqual([]);
  expect(a.subs).toEqual([
    { id: "assembly/corner@left", parent: "assembly", assembly: "corner", name: "left" },
    { id: "assembly/corner@right", parent: "assembly", assembly: "corner", name: "right" },
  ]);
  expect(a.instances.map((i) => [i.id, i.scope])).toEqual([
    ["assembly/cart:chassis", "assembly"],
    ["assembly/corner@left/cart:bolt", "assembly/corner@left"],
    ["assembly/corner@left/cart:wheel", "assembly/corner@left"],
    ["assembly/corner@right/cart:bolt", "assembly/corner@right"],
    ["assembly/corner@right/cart:wheel", "assembly/corner@right"],
  ]);
  expect(a.fixed).toEqual(["assembly/cart:chassis"]); // the corners' own fix doesn't pin them to the world
  expect(a.joints.map((j) => j.name)).toEqual(["corner@left/spin", "corner@right/spin", "cart:chassis+corner@left/cart:bolt", "cart:chassis+corner@right/cart:bolt"]);
  const { spec, problems } = resolveAssembly(a, (p) => results[p].connectors ?? {});
  expect(problems).toEqual([]);
  const mech = new Mechanism({ ...spec, scale: 100 });
  expect(mech.error()).toBeLessThan(1e-9);
  expect(mech.dof()).toBe(2);
  const close = (p: number[], q: number[]) => p.forEach((v, i) => expect(v).toBeCloseTo(q[i], 6));
  // bolt head on the axle, its shaft back into the chassis (the head's z is -Z in its part); the wheel outboard of the head
  close(mech.pointAt("assembly/corner@right/cart:bolt", [0, 0, 0]), [40, -30, 5]);
  close(mech.pointAt("assembly/corner@right/cart:bolt", [0, 0, 20]), [40, -10, 5]);
  close(mech.pointAt("assembly/corner@right/cart:wheel", [0, 0, 0]), [40, -30, 5]);
  close(mech.pointAt("assembly/corner@right/cart:wheel", [0, 0, 8]), [40, -38, 5]);
  // the corner itself still solves on its own
  const c = all.find((x) => x.id === "corner")!;
  expect(c.problems).toEqual([]);
  expect(new Mechanism({ ...resolveAssembly(c, (p) => results[p].connectors ?? {}).spec, scale: 100 }).error()).toBeLessThan(1e-9);
});

test("copies placed by hand; mistakes with copies are problems", () => {
  const e = new Engine();
  const mk = (body: string) => {
    e.setDocument({ scripts: { "studios/cart.ts": CART, "studios/assembly.ts": `import { assembly } from "parasocial";\nimport { chassis, wheel, bolt } from "./cart";\nimport self from "./assembly";\nexport default assembly("Cart", (t) => {\n${body}\n});\n` } });
    const [a] = e.assemblies();
    return a;
  };
  let a = mk(`t.insert(wheel, { name: "spare", place: { translate: [0, 0, 50], rotate: { axis: "X", angle: 90 } } });`);
  expect(a.problems).toEqual([]);
  const r = a.instances[0].place!.r.map((v) => Math.round(v * 1e9) / 1e9 + 0);
  expect(r).toEqual([1, 0, 0, 0, 0, -1, 0, 1, 0]);
  expect(a.instances[0].place!.t).toEqual([0, 0, 50]);

  expect(mk(`t.insert(wheel); t.insert(wheel);`).problems[0].message).toContain('name each copy, insert(Wheel, { name: "2" })');
  expect(mk(`t.insert(wheel, { name: "a/b" });`).problems[0].message).toContain('without "/" or "@"');
  expect(mk(`t.insert(self, { name: "again" });`).problems[0].message).toContain("inserts itself");
  expect(mk(`t.revolute(chassis.at("axle", 0), wheel, { min: 0 });`).problems[0].message).toContain("connector to connector takes two connectors");
  const results = regenAll(e);
  a = mk(`t.revolute(chassis.at("axle"), wheel.at("hub")); t.revolute(chassis.at("axle", 9), bolt.at("head"));`);
  expect(a.problems).toEqual([]);
  expect(resolveAssembly(a, (p) => results[p].connectors ?? {}, (p) => results[p].name).problems.map((p) => p.message)).toEqual([
    'Chassis has 4 "axle" frames: pick one, .at("axle", 0) to .at("axle", 3)',
    'Chassis has 4 "axle" frames (0 to 3), so there\'s no .at("axle", 9)',
  ]);
});

test("the lead-screw slide example: gear and screw relations make one degree of freedom", async () => {
  const { Mechanism } = await import("@parasocial/assembly");
  const { Glob } = await import("bun");
  const { join } = await import("node:path");
  const { readFileSync } = await import("node:fs");
  const root = join(import.meta.dir, "../../../examples/slide");
  const scripts: Record<string, string> = {};
  for (const f of new Glob("{studios,lib}/*.ts").scanSync(root)) scripts[f] = readFileSync(join(root, f), "utf8");
  const e = new Engine();
  e.setDocument({ scripts });
  const results = regenAll(e);
  for (const r of Object.values(results)) expect(r.ok).toBe(true);
  const [a] = e.assemblies();
  expect(a.problems).toEqual([]);
  expect(a.relations).toEqual([
    { kind: "gear", a: "crank", ia: 0, b: "screw", ib: 0, ratio: -0.5, offset: 0, scope: "mechanism", source: expect.objectContaining({ file: "studios/mechanism.ts", line: 15 }) },
    { kind: "screw", a: "screw", ia: 0, b: "carriage", ib: 0, ratio: 8 / 360, offset: 0, scope: "mechanism", source: expect.objectContaining({ file: "studios/mechanism.ts", line: 17 }) },
  ]);
  const { spec, problems } = resolveAssembly(a, (p) => results[p].connectors ?? {});
  expect(problems).toEqual([]);
  expect(spec.couplings).toHaveLength(2);
  const mech = new Mechanism({ ...spec, scale: 80 });
  expect(mech.dof()).toBe(1);
  expect(mech.drivers()).toEqual(["crank"]);
  for (const id of a.instances.map((i) => i.id).filter((i) => i !== "mechanism/slide")) expect(mech.movable(id)).toBe(true);
  // nothing overlaps at home
  expect(e.interferences(a.instances.map((i) => i.id))).toEqual([]);
  // pushing the carriage 20 mm turns the screw 2.5 turns and the crank 5 the other way
  for (let x = 2; x <= 20; x += 2) mech.drag("mechanism/slide:carriage", [0, 15, 30], [x, 15, 30]);
  const v = mech.values();
  expect(v.carriage[0]).toBeCloseTo(20, 1);
  expect(v.screw[0]).toBeCloseTo(900, -1);
  expect(v.crank[0]).toBeCloseTo(-1800, -1);
  expect(mech.error()).toBeLessThan(1e-4);
  // cranking past the end stops at the end plate
  mech.setValues({ crank: [-10000] });
  expect(mech.values().carriage[0]).toBeCloseTo(47, 3);
  expect(mech.values().crank[0]).toBeCloseTo(-47 * 90, 0);
});

test("relations: misuse is a problem with a source line", () => {
  const e = new Engine();
  const asm = (body: string) => `import { assembly } from "parasocial";
import base, { lid } from "./box";
export default assembly("Box", ({ revolute, slider, gear, screw, rackPinion }) => {
  ${body}
});
`;
  const problem = (body: string) => {
    e.setDocument({ scripts: { "studios/box.ts": BOX, "studios/mech.ts": asm(body) } });
    const [a] = e.assemblies();
    expect(a.problems.every((p) => p.source?.line === 4)).toBe(true);
    return a.problems.map((p) => p.message.replace(/ \(mech\.ts:\d+\)$/, ""));
  };
  expect(problem(`const h = revolute(base, lid, base.at("hinge")); gear(h, 3, 2);`)).toEqual(["gear(a, b, ratio): pass joints returned by revolute(), slider() or cylindrical(), const spin = revolute(...)"]);
  expect(problem(`const s = slider(base, lid, base.at("hinge"), { name: "lift" }); gear(s, s, 2);`)).toEqual(['gear: "lift" doesn\'t turn; use a revolute or cylindrical joint']);
  expect(problem(`const h = revolute(base, lid, base.at("hinge")); rackPinion(h, h, 5);`)).toEqual(["rackPinion: the rack: the revolute joint doesn't slide; use a slider or cylindrical joint"]);
  expect(problem(`const h = revolute(base, lid, base.at("hinge")); screw(h, 2);`)).toEqual(["screw(joint, lead): the revolute joint isn't cylindrical; for a separate nut or carriage, screw(leadScrew, carriage, lead)"]);
  expect(problem(`const h = revolute(base, lid, base.at("hinge")); gear(h, h, 0);`)).toEqual(["gear(a, b, ratio): ratio must be a non-zero number"]);
});

test("studio and assembly descriptions reach the part and assembly lists and the BOM", () => {
  const e = new Engine();
  const box = BOX.replace(`export const name = "Box";`, `export const name = "Box";\nexport const description = "Hinged box with a flat lid";`);
  const mech = ASM.replace(`export default assembly("Box", ({ revolute }) => {
  revolute(base, lid, base.at("hinge"), { min: -120, max: 0, name: "hinge" });
});`, `export default assembly("Box", ({ revolute }) => {
  revolute(base, lid, base.at("hinge"), { min: -120, max: 0, name: "hinge" });
}, { description: "Lid swings open 120°", partNumber: "BX-1" });`);
  e.setDocument({ scripts: { "studios/box.ts": box, "studios/mech.ts": mech } });
  expect(e.partInfos().map((p) => p.studioDescription)).toEqual(["Hinged box with a flat lid", "Hinged box with a flat lid"]);
  const [a] = e.assemblies();
  expect([a.description, a.partNumber, a.studioDescription]).toEqual(["Lid swings open 120°", "BX-1", undefined]);
  const bom = computeBom(e, { assembly: "mech" });
  expect([bom.partNumber, bom.description]).toEqual(["BX-1", "Lid swings open 120°"]);
  expect(bomToMarkdown(bom)).toStartWith("# Bill of materials: Box (BX-1)\n\nLid swings open 120°\n");
});

test("assembly options are checked", () => {
  const e = new Engine();
  e.setDocument({ scripts: { "studios/box.ts": BOX, "studios/mech.ts": ASM.replace(`name: "hinge" });\n});`, `name: "hinge" });\n}, { material: "steel" } as any);`) } });
  expect(e.assemblies()).toEqual([]);
  expect(e.regenerate("mech").problems[0].message).toContain('unknown option "material"; use partNumber, description');
});

test("an assembly a studio both exports and inserts shows twice: a warning on the export", () => {
  const CORNER = `assembly("Corner", ({ fix, revolute }) => {
  fix(bolt);
  revolute(bolt.at("head"), wheel.at("hub"), { name: "spin" });
})`;
  const e = new Engine();
  e.setDocument({
    scripts: {
      "studios/cart.ts": CART,
      "studios/rig.ts": `import { assembly } from "parasocial";
import { chassis, wheel, bolt } from "./cart";
export const name = "Rig";

export const corner = ${CORNER};
export const axle = assembly("Axle", ({ insert }) => {
  insert(corner, { name: "left" });
});
export default assembly("Cart", ({ insert, fix }) => {
  fix(chassis);
  insert(axle);
});
`,
    },
  });
  const all = e.assemblies();
  const byId = (id: string) => all.find((a) => a.id === id)!;
  // nested inserts count: the corner is in the cart through the axle (the default export is checked first)
  expect(byId("rig:corner").problems).toEqual([
    { severity: "warning", kind: "runtime", message: 'studio "Rig" shows "Corner" twice: exported and inserted by "Cart". Export "Corner" from its own studio and import it here (rig.ts:5)', part: "rig:corner", source: { file: "studios/rig.ts", line: 5 } },
  ]);
  expect(byId("rig:axle").problems.map((p) => p.message)).toEqual(['studio "Rig" shows "Axle" twice: exported and inserted by "Cart". Export "Axle" from its own studio and import it here (rig.ts:9)']);
  expect(byId("rig").problems).toEqual([]);

  // two assemblies in a studio that don't insert each other, or an insert from another studio: nothing shows twice
  e.setDocument({
    scripts: {
      "studios/cart.ts": CART,
      "studios/corner.ts": `import { assembly } from "parasocial";
import { wheel, bolt } from "./cart";
export default ${CORNER};
`,
      "studios/rig.ts": `import { assembly } from "parasocial";
import { chassis, wheel, bolt } from "./cart";
import corner from "./corner";
export const spare = ${CORNER.replace('"Corner"', '"Spare"')};
export default assembly("Cart", ({ insert, fix }) => {
  fix(chassis);
  insert(corner);
});
`,
    },
  });
  expect(e.assemblies().flatMap((a) => a.problems)).toEqual([]);
});
