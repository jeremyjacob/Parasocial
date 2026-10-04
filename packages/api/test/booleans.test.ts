// Booleans with several tools or none, and per-operation timings.
import { beforeAll, expect, test } from "bun:test";
import { loadKernel } from "@parasocial/kernel";
import { OpCache } from "@parasocial/naming";
import { PartContext, runPart } from "../src/internal";
import { part, box, cylinder, type Solid } from "../src";

beforeAll(async () => {
  await loadKernel();
});

const run = (name: string, fn: () => Solid) => {
  const cache = new OpCache();
  cache.begin();
  return runPart(part(name, fn), new PartContext({ part: name, file: `studios/${name}.ts`, cache }));
};

function solid(fn: () => Solid) {
  let s!: Solid;
  const r = run("b", () => (s = fn()));
  expect(r.problems.filter((p) => p.severity === "error")).toEqual([]);
  return s;
}

test("intersect with several solids keeps what is common to all of them (not this ∩ (a ∪ b))", () => {
  // a 100×10×10 band, two 10 mm cubes inside it at x 0..10 and x 50..60, and a field covering x < 55
  const band = () => box(100, 10, 10);
  const bores = () => box(10, 10, 10).union(box(10, 10, 10).translate([50, 0, 0]));
  const field = () => box(55, 10, 10);
  const both = solid(() => band().intersect(bores(), field()));
  // ∩ of all three: the first cube and half the second
  expect(both.volume()).toBeCloseTo(1000 + 500, 3);
  const chained = solid(() => band().intersect(bores()).intersect(field()));
  expect(both.volume()).toBeCloseTo(chained.volume(), 6);
  // a tag still lands on the result
  const tagged = solid(() => band().intersect(bores(), field(), { tag: "common" }));
  expect(tagged.volume()).toBeCloseTo(1500, 3);
});

test("booleans with no other solids return the solid unchanged", () => {
  const holes: Solid[] = [];
  const s = solid(() => box(10, 10, 10).subtract(...holes));
  expect(s.volume()).toBeCloseTo(1000, 6);
  expect(solid(() => box(10, 10, 10).union(...holes, { tag: "u" })).volume()).toBeCloseTo(1000, 6);
  expect(solid(() => box(10, 10, 10).intersect()).volume()).toBeCloseTo(1000, 6);
  // an array passed without spreading is a mistake worth naming
  const r = run("arr", () => box(10, 10, 10).subtract([cylinder(2, 20)] as any));
  expect(r.problems[0]?.message).toContain("spread it with ...");
});

test("a run reports the operations that ran and the slowest of them", () => {
  const r = run("t", () => box(10, 10, 10).subtract(cylinder(2, 20, { tag: "bore" })));
  expect(r.timings.opCount).toBe(3);
  expect(r.timings.slowest.length).toBe(3);
  const ms = r.timings.slowest.map((o) => o.ms!);
  expect([...ms].sort((a, b) => b - a)).toEqual(ms);
  expect(r.timings.slowest.find((o) => o.type === "cylinder")).toMatchObject({ tag: "bore", id: "t/bore", part: "t" });
});
