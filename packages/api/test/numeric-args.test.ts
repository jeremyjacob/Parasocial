// NaN / Infinity / undefined where a number belongs fail at the API boundary, as a script error
// at the caller's line, instead of reaching OCCT (which builds garbage, hangs or traps on them).
import { beforeAll, expect, test } from "bun:test";
import { loadKernel } from "@parasocial/kernel";
import { OpCache } from "@parasocial/naming";
import { PartContext, runPart, part, parseStack, type PartBody } from "@parasocial/api/internal";
import { box, cylinder } from "../src/solid";
import { sketch } from "../src/sketch";
import { plane } from "../src/plane";
import { path3d } from "../src/path3d";
import { num, vec3, points2 } from "../src/check";

beforeAll(async () => {
  await loadKernel();
});

const run = (body: PartBody) => {
  const cache = new OpCache();
  cache.begin();
  return runPart(part("P", body), new PartContext({ part: "p", file: "studios/p.ts", cache, isUserFile: (f) => f.endsWith("numeric-args.test.ts") }));
};
const problem = (body: PartBody) => {
  const r = run(body);
  expect(r.ok).toBe(false);
  return r.problems[0];
};
const lib: any = {};

test("translate names the bad coordinate and points at the calling line", () => {
  const p = problem(() => box(10, 10, 10).translate([0, lib.y, 0]));
  expect(p.message).toStartWith("translate: y is undefined (");
  expect(p.kind).toBe("runtime");
  // (script line mapping is covered end to end in packages/runtime/test/robustness.test.ts: test
  // modules are strict, and JSC's proper tail calls drop the arrow frames used here)
  expect(problem(() => box(10, 10, 10).translate([0, NaN, 0])).message).toStartWith("translate: y is NaN");
  expect(problem(() => box(10, 10, 10).translate([Infinity, 0, 0])).message).toStartWith("translate: x is Infinity");
  expect(problem(() => box(10, 10, 10).translate([0, 0] as any)).message).toStartWith("translate must be [x, y, z] (got 2 values)");
});

test("primitives, sketches, extrudes and patterns reject non-finite numbers", () => {
  const cases: [PartBody, string][] = [
    [() => box(lib.w, 10, 10), "box width is undefined"],
    [() => box(10, NaN, 10), "box depth is NaN"],
    [() => cylinder(lib.r * 2, 10), "cylinder radius is NaN"],
    [() => cylinder(5, 10, { at: [0, lib.y, 0] }), "cylinder at: y is undefined"],
    [() => sketch(plane.XY).rect(10, 10).extrude(lib.h), "extrude distance is undefined"],
    [() => sketch(plane.XY).rect(10, 10).extrude(-Infinity), "extrude distance is -Infinity"],
    [() => sketch(plane.XY).polyline([[0, 0], [10, 0], [10, lib.y / 2], [0, 10]]).extrude(5), "polyline: point 3: y is NaN"],
    [() => sketch(plane.XY).moveTo([0, 0]).lineTo([lib.x, 5]).close().extrude(5), "lineTo: x is undefined"],
    [() => sketch(plane.XY).circle([0, NaN], 5).extrude(5), "circle center: y is NaN"],
    [() => sketch(plane.XY).circle([0, 0], lib.r).extrude(5), "circle radius is undefined"],
    [() => sketch(plane.XY).rect(10, 10).revolve(lib.angle * 2, { axis: "X" }), "revolve angle is NaN"],
    [() => box(10, 10, 10).linearPattern("X", lib.n, 20), "linearPattern count is undefined"],
    [() => box(10, 10, 10).linearPattern("X", 3, NaN), "linearPattern spacing is NaN"],
    [() => box(10, 10, 10).circularPattern(2.5), "circularPattern count must be a whole number of at least 1 (got 2.5)"],
    [() => box(10, 10, 10).rotate(lib.a), "rotate angle is undefined"],
    [() => box(10, 10, 10).rotate(45, { axis: [0, 0, NaN] }), "rotate axis: z is NaN"],
    [() => box(10, 10, 10).fillet(">Z", lib.r), "fillet radius is undefined"],
    [() => box(10, 10, 10).hole([5, lib.y, 10], 3), "hole point: y is undefined"],
    [() => sketch(plane.at([0, 0, lib.z])).rect(10, 10).extrude(5), "plane.at origin: z is undefined"],
    [() => sketch(plane.XY.offset(NaN)).rect(10, 10).extrude(5), "plane offset is NaN"],
    [() => box(1, 1, 1).union(sketch(plane.XZ).circle([0, 0], 1).sweep(path3d([0, 0, 0]).lineTo([0, NaN, 10]))), "lineTo point: y is NaN"],
    [() => box("10" as any, 10, 10), 'box width must be a number (got the string "10")'],
  ];
  for (const [body, msg] of cases) {
    const p = problem(body);
    expect(p.message).toStartWith(msg);
    expect(p.kind).toBe("runtime");
  }
});

test("valid inputs still build", () => {
  const r = run(() =>
    sketch(plane.XY)
      .rect(20, 10)
      .extrude(5)
      .translate([1, 2, 3])
      .rotate(30, { axis: [0, 0, 1] })
      .linearPattern("X", 2, 30)
      .union(cylinder(3, 8, { at: [0, 0, 5] })),
  );
  expect(r.problems).toEqual([]);
  expect(r.ok).toBe(true);
});

test("the checks work outside a part (module top level) as plain errors", () => {
  expect(() => num(NaN, "width")).toThrow("width is NaN");
  expect(() => vec3([1, undefined, 3], "origin")).toThrow("origin: y is undefined");
  expect(() => points2([[0, 0], [1, null]], "outline")).toThrow("outline: point 2: y is null");
  expect(() => plane.at([0, NaN, 0])).toThrow("plane.at origin: y is NaN");
});

test("V8 stack frames of script code (sourceURL plus \", <anonymous>\") parse to the script file", () => {
  const [f] = parseStack("    at body (ps:///studios/fairlead.ts, <anonymous>:3:26)");
  expect(f).toEqual({ fn: "body", file: "ps:///studios/fairlead.ts", line: 3, col: 26 });
});
