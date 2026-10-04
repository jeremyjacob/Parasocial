// Intended overlaps (expectOverlap), where overlaps are (box, centroid), and pair ops cut short by a time budget.
import { beforeAll, expect, test } from "bun:test";
import { loadKernel } from "@parasocial/kernel";
import { Engine, overlapIntended } from "../src";

beforeAll(async () => {
  await loadKernel();
});

// a 20 mm plate, a pin through it (modeled in place, overlapping), a nut beside it
const PARTS = `import { part, box, cylinder } from "parasocial";
export default part("Plate", () => box(20, 20, 4, { center: "xy" }));
export const pin = part("Pin", () => cylinder(2, 10, { center: true }));
export const nut = part("Nut", () => box(4, 4, 4).translate([30, 0, 0]));
`;
const asm = (body: string) => `import { assembly } from "parasocial";
import plate, { pin, nut } from "./parts";
export const sub = assembly("Sub", ({ fastened }) => { fastened(pin, nut); });
export default assembly("Rig", ({ fastened, insert, expectOverlap }) => {
${body}
});
`;
const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function engine(body: string) {
  const e = new Engine();
  e.setDocument({ scripts: { "studios/parts.ts": PARTS, "studios/rig.ts": asm(body) } });
  for (const p of e.parts()) e.regenerate(p);
  return e;
}

test("expectOverlap: copies, arrays and subassemblies; interferences skip them; bad sides are problems", () => {
  let e = engine(`  fastened(plate, pin);
  const s = insert(sub, { name: "a", place: { translate: [0, 0, 1] } });
  fastened(plate, s.part(pin));
  expectOverlap(plate, [pin], { reason: "press fit" });`);
  let [a] = e.assemblies().filter((x) => x.id === "rig");
  expect(a.problems).toEqual([]);
  expect(a.overlaps).toEqual([{ a: "rig/parts", b: "rig/parts:pin", scope: "rig", reason: "press fit", source: { file: "studios/rig.ts", line: 8, col: expect.any(Number) } }]);
  const ids = a.instances.map((i) => i.id);
  expect(overlapIntended(a, "rig/parts:pin", "rig/parts")).toBe("expected");
  expect(overlapIntended(a, "rig/parts", "rig/rig:sub@a/parts:pin")).toBeUndefined();
  // the subassembly's pin still collides with the plate
  expect(e.interferences(ids).map((h) => [h.a, h.b])).toEqual([["rig/parts", "rig/rig:sub@a/parts:pin"], ["rig/parts:pin", "rig/rig:sub@a/parts:pin"]]);
  expect(e.intendedPairs(ids)).toEqual([["rig/parts", "rig/parts:pin"]]);

  // a whole subassembly copy stands for all its parts
  e = engine(`  fastened(plate, pin);
  const s = insert(sub, { name: "a" });
  fastened(plate, s.part(pin));
  expectOverlap(plate, [pin, s]);`);
  [a] = e.assemblies().filter((x) => x.id === "rig");
  expect(a.overlaps!.map((o) => [o.a, o.b])).toEqual([["rig/parts", "rig/parts:pin"], ["rig/parts", "rig/rig:sub@a"]]);
  expect(overlapIntended(a, "rig/rig:sub@a/parts:pin", "rig/parts")).toBe("expected");
  // (the two pins, both modeled in place, weren't declared)
  expect(e.interferences(a.instances.map((i) => i.id)).map((h) => [h.a, h.b])).toEqual([["rig/parts:pin", "rig/rig:sub@a/parts:pin"]]);

  // not in the assembly: a problem with its line, nothing expected
  e = engine(`  fastened(plate, pin);
  expectOverlap(plate, nut);`);
  [a] = e.assemblies().filter((x) => x.id === "rig");
  expect(a.overlaps).toBeUndefined();
  expect(a.problems.map((p) => [p.message, p.source?.line])).toEqual([[`expectOverlap: "Nut" isn't in this assembly; join, fix or insert it first (rig.ts:6)`, 6]]);
  // misuse throws at the call
  e = engine(`  fastened(plate, pin);
  expectOverlap(plate, 3);`);
  expect(e.assemblies().find((x) => x.id === "rig")!.problems[0].message).toContain("expectOverlap(a, b, { reason? }): b must be a part");
});

test("overlaps come with their world bounding box and centroid; touching and far pairs are null", () => {
  const e = new Engine();
  e.setDocument({ scripts: { "studios/parts.ts": PARTS } });
  for (const p of e.parts()) e.regenerate(p);
  const o = e.overlap("parts", "parts:pin")!;
  // the pin's middle 4 mm, inside the plate: a cylinder r 2 from z 0 to 4
  expect(o.volume).toBeCloseTo(Math.PI * 4 * 4, 1);
  expect(o.centroid.map((x) => +x.toFixed(4) + 0)).toEqual([0, 0, 2]);
  expect(o.bbox.min.map((x) => +x.toFixed(3) + 0)).toEqual([-2, -2, 0]);
  expect(o.bbox.max.map((x) => +x.toFixed(3) + 0)).toEqual([2, 2, 4]);
  expect(e.interference("parts", "parts:pin")).toBeCloseTo(o.volume, 6);
  // moved by poses (and cached by relative pose: the second call is the same answer)
  e.setPoses({ "parts:pin": { r: I, t: [5, 0, 0] }, parts: { r: I, t: [5, 0, 0] } });
  for (let i = 0; i < 2; i++) expect(e.overlap("parts", "parts:pin")!.centroid.map((x) => +x.toFixed(4) + 0)).toEqual([5, 0, 2]);
  e.setPoses({});
  expect(e.overlap("parts", "parts:nut")).toBeNull();
  expect(e.overlap("parts", "nope")).toBeNull();
  // interferences carry the same, in world coordinates
  e.setPoses({ "parts:pin": { r: I, t: [0, 0, -3] } });
  const [hit] = e.interferences(["parts", "parts:pin"]);
  expect(hit.volume).toBeCloseTo(Math.PI * 4 * 2, 1);
  expect(hit.centroid!.map((x) => +x.toFixed(4) + 0)).toEqual([0, 0, 1]);
  expect(hit.bbox!.min.map((x) => +x.toFixed(3) + 0)).toEqual([-2, -2, 0]);
  expect(hit.bbox!.max.map((x) => +x.toFixed(3) + 0)).toEqual([2, 2, 2]);
});

test("pair ops stop after their time budget, answering the first pairs", () => {
  const e = new Engine();
  e.setDocument({ scripts: { "studios/parts.ts": PARTS } });
  for (const p of e.parts()) e.regenerate(p);
  const pairs: [string, string][] = [["parts", "parts:pin"], ["parts", "parts:nut"], ["parts:pin", "parts:nut"]];
  expect(e.overlaps(pairs).length).toBe(3);
  expect(e.overlaps(pairs, -1).length).toBe(1);
  expect(e.distances(pairs, 50).length).toBe(3);
  const [first] = e.distances(pairs, 50, -1);
  expect(e.distances(pairs, 50, -1).length).toBe(1);
  expect(first!.distance).toBeCloseTo(0, 9);
});
