// Placing a part carries what's joined to it; fix(subassembly) holds its root; joint names in subassemblies.
import { beforeAll, expect, test } from "bun:test";
import { loadKernel } from "@parasocial/kernel";
import { Mechanism, rotation, applyPoint, type Vec3 } from "@parasocial/assembly";
import { Engine } from "../src";
import { resolveAssembly, unsatisfied } from "../src/mechanism";

beforeAll(async () => {
  await loadKernel();
});

// a winch modeled lying down: frame plate, motor bolted on top, drum on an axle along X; a drive
// subassembly (gearbox + output shaft that turns) bolted to the frame's side
const PARTS = `import { part, box, cylinder } from "parasocial";
export const frame = part("Frame", () => box(100, 60, 10, { center: "xy" }).connector("axle", { origin: [0, 0, 30], axis: "X" }));
export const motor = part("Motor", () => box(20, 20, 20, { center: "xy" }).translate([30, 0, 10]));
export const drum = part("Drum", () => cylinder(15, 40, { at: [-20, 0, 30], axis: "X" }));
export const gearbox = part("Gearbox", () => box(20, 20, 20, { center: "xy" }).translate([-40, 0, 10]).connector("out", { origin: [-40, 0, 40], axis: "Z" }));
export const shaft = part("Shaft", () => cylinder(3, 20, { at: [-40, 0, 30] }));
`;
const DRIVE = `import { assembly } from "parasocial";
import { gearbox, shaft } from "./parts";
export default assembly("Drive", ({ fix, revolute }) => {
  fix(gearbox);
  revolute(gearbox, shaft, gearbox.at("out"), { name: "spin" });
});
`;
const winch = (body: string) => `import { assembly } from "parasocial";
import { frame, motor, drum, gearbox, shaft } from "./parts";
import drive from "./drive";
export default assembly("Winch", ({ insert, fix, fastened, revolute }) => {
${body}
});
`;
const JOINTS = `  fastened(frame, motor);
  revolute(frame, drum, frame.at("axle"), { name: "Drum rotation" });
  const d = insert(drive, { name: "upright" });
  fastened(frame, d.part(gearbox));`;

function solve(body: string) {
  const e = new Engine();
  e.setDocument({ scripts: { "studios/parts.ts": PARTS, "studios/drive.ts": DRIVE, "studios/winch.ts": winch(body) } });
  const results = Object.fromEntries(e.parts().map((p) => [p, e.regenerate(p)]));
  const a = e.assemblies().find((x) => x.id === "winch")!;
  expect(a.problems).toEqual([]);
  const resolved = resolveAssembly(a, (p) => results[p].connectors ?? {}, (p) => results[p].name);
  return { a, resolved, mech: new Mechanism({ ...resolved.spec, scale: 100 }) };
}
const close = (p: number[], q: number[]) => p.forEach((v, i) => expect(v).toBeCloseTo(q[i], 6));
// standing it up: a quarter turn about X
const up = (p: Vec3) => applyPoint({ r: rotation([1, 0, 0], Math.PI / 2), t: [0, 0, 0] }, p);

test("placing the root part carries everything fastened or jointed to it", () => {
  const { a, resolved, mech } = solve(`  insert(frame, { place: { rotate: { axis: "X", angle: 90 } } });\n${JOINTS}`);
  // ids don't change: the placed frame is still the assembly's one copy
  expect(a.instances.map((i) => i.id)).toEqual(["winch/parts:frame", "winch/parts:motor", "winch/parts:drum", "winch/drive@upright/parts:gearbox", "winch/drive@upright/parts:shaft"]);
  expect(resolved.problems).toEqual([]);
  expect(mech.error()).toBeLessThan(1e-9);
  for (const [id, p] of [
    ["winch/parts:frame", [50, 30, 5]],
    ["winch/parts:motor", [30, 0, 20]],
    ["winch/parts:drum", [-20, 0, 45]],
    ["winch/drive@upright/parts:gearbox", [-40, 0, 20]],
    ["winch/drive@upright/parts:shaft", [-40, 0, 50]],
  ] as [string, Vec3][])
    close(mech.pointAt(id, p), up(p));
  // the joints still turn about their (carried) axes
  mech.setValues({ "Drum rotation": [90], "drive@upright/spin": [45] });
  expect(mech.error()).toBeLessThan(1e-9);
  close(mech.pointAt("winch/parts:drum", [0, 0, 30]), up([0, 0, 30])); // on the axle: stays
  close(mech.pointAt("winch/parts:drum", [0, 0, 45]), up([0, -15, 30])); // turned a quarter about +X
  close(mech.pointAt("winch/parts:motor", [30, 0, 20]), up([30, 0, 20]));
});

test("joints at their values: placing still carries them, then the values apply", () => {
  const { mech } = solve(`  insert(frame, { place: { rotate: { axis: "X", angle: 90 }, translate: [0, 0, 100] } });\n${JOINTS.replace(`{ name: "Drum rotation" }`, `{ name: "Drum rotation", value: 90 }`)}`);
  const T = (p: Vec3) => {
    const q = up(p);
    return [q[0], q[1], q[2] + 100];
  };
  close(mech.pointAt("winch/parts:drum", [0, 0, 45]), T([0, -15, 30]));
  close(mech.pointAt("winch/parts:motor", [30, 0, 20]), T([30, 0, 20]));
});

test("two parts placed apart but joined: the joint holds them where placed, with a warning", () => {
  const { resolved, mech } = solve(`  insert(frame, { place: { rotate: { axis: "X", angle: 90 } } });\n  insert(motor, { place: { translate: [0, 0, 5] } });\n${JOINTS}`);
  close(mech.pointAt("winch/parts:motor", [30, 0, 20]), [30, 0, 25]);
  expect(mech.error()).toBeLessThan(1e-9);
  expect(resolved.problems.map((p) => p.message)).toEqual([expect.stringMatching(/^Frame and Motor are placed separately, so their fastened joint "parts:frame\+parts:motor" holds them where placed/)]);
});

test("fix(subassembly) holds its root part; its own joints still move", () => {
  const { a, mech } = solve(`${JOINTS}\n  fix(d);`);
  expect(a.fixed).toEqual(["winch/drive@upright/parts:gearbox"]);
  expect(mech.movable("winch/drive@upright/parts:shaft")).toBe(true);
  expect(mech.movable("winch/parts:frame")).toBe(false);
  expect(mech.setValues({ "drive@upright/spin": [45] })).toBeLessThan(1e-9);
  expect(mech.values()["drive@upright/spin"][0]).toBeCloseTo(45, 6);
});

test("a joint held open by fixed parts says so", () => {
  const { mech } = solve(`${JOINTS.replace(`{ name: "Drum rotation" }`, `{ name: "Drum rotation", min: 30, max: 90 }`)}\n  fix(frame, drum);`);
  const err = mech.settle();
  expect(err).toBeGreaterThan(1);
  expect(unsatisfied(mech, err, (p) => p.slice(p.indexOf(":") + 1))).toMatch(/^joint "Drum rotation" can't close \(off by [\d.]+\): it's held between two fixed parts, frame and drum \(winch\/parts:frame, winch\/parts:drum\)/);
  // connectors that don't meet, nothing fixed in the way
  const { mech: m2 } = solve(`${JOINTS.replace(`{ name: "Drum rotation" }`, `{ name: "Drum rotation", min: 30, max: 90 }`)}\n  revolute(frame, drum, { origin: [0, 0, 0], axis: "Z" }, { name: "again" });`);
  expect(unsatisfied(m2, m2.settle())).toMatch(/^joint "(again|Drum rotation)" can't close .*check that connectors line up/);
});
