// The API docs agents read (JSDoc, served by the MCP api_reference tool) must be true: plane
// conventions are checked against real geometry, and every @example runs.
import { beforeAll, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadKernel } from "@parasocial/kernel";
import { OpCache } from "@parasocial/naming";
import { PartContext, runPart } from "../src/internal";
import * as api from "../src";
import { part, sketch, plane, box, cylinder, Solid, type Plane, type PartDef } from "../src";

beforeAll(async () => {
  await loadKernel();
});

const run = (def: PartDef) => {
  const cache = new OpCache();
  cache.begin();
  return runPart(def, new PartContext({ part: "t", file: "studios/t.ts", cache }));
};
const errors = (r: ReturnType<typeof run>) => r.problems.filter((p) => p.severity === "error").map((p) => p.message);
const round = (v: readonly number[]) => v.map((x) => Math.round(x * 1000) / 1000 + 0);

/** Bounding box of a 10 (u) × 2 (v) rect with its corner at the sketch origin, extruded 1. */
function slab(p: Plane) {
  let s!: Solid;
  const r = run(part("t", () => (s = sketch(p).rect(10, 2, { center: false }).extrude(1))));
  expect(errors(r)).toEqual([]);
  const b = s.boundingBox();
  return { min: round(b.min), max: round(b.max) };
}

test("plane conventions match the docs (sketch axes, normals, offsets)", () => {
  // plane.XY: [u, v] -> [x, y], normal +Z
  expect(slab(plane.XY)).toEqual({ min: [0, 0, 0], max: [10, 2, 1] });
  // plane.XZ: [u, v] -> [x, z], normal -Y (extrudes toward -Y)
  expect(slab(plane.XZ)).toEqual({ min: [0, -1, 0], max: [10, 0, 2] });
  // plane.YZ: [u, v] -> [y, z], normal +X
  expect(slab(plane.YZ)).toEqual({ min: [0, 0, 0], max: [1, 10, 2] });
  expect(slab(plane.top)).toEqual(slab(plane.XY));
  expect(slab(plane.front)).toEqual(slab(plane.XZ));
  expect(slab(plane.right)).toEqual(slab(plane.YZ));
  // offsets move along the normal: XZ.offset(5) is y = -5
  expect(slab(plane.XY.offset(5))).toEqual({ min: [0, 0, 5], max: [10, 2, 6] });
  expect(slab(plane.XZ.offset(5))).toEqual({ min: [0, -6, 0], max: [10, -5, 2] });
  expect(slab(plane.YZ.offset(5))).toEqual({ min: [5, 0, 0], max: [6, 10, 2] });
  expect(slab(plane.offset(plane.XZ, 5))).toEqual(slab(plane.XZ.offset(5)));
  // flipped XZ: [x, -z], normal +Y
  expect(slab(plane.XZ.flipped())).toEqual({ min: [0, 0, -2], max: [10, 1, 0] });
  // plane.at: u horizontal, v up
  expect(slab(plane.at([0, 0, 0], "X"))).toEqual(slab(plane.YZ));
  expect(slab(plane.at([0, 0, 0], "Y"))).toEqual({ min: [-10, 0, 0], max: [0, 1, 2] });
  expect(slab(plane.at([0, 0, 0], "Z"))).toEqual(slab(plane.XY));
  // rotated / threePoint
  expect(slab(plane.XY.rotated(90))).toEqual(slab(plane.XZ));
  expect(slab(plane.threePoint([0, 0, 0], [1, 0, 0], [0, 1, 0]))).toEqual(slab(plane.XY));
  expect(slab(plane.XY.at([3, 4]))).toEqual({ min: [3, 4, 0], max: [13, 6, 1] });
});

test("extrude, revolve and primitives place geometry as documented", () => {
  const box3 = (fn: () => Solid) => {
    let s!: Solid;
    expect(errors(run(part("t", () => (s = fn()))))).toEqual([]);
    const b = s.boundingBox();
    return { min: round(b.min), max: round(b.max) };
  };
  expect(box3(() => sketch(plane.XZ).rect(10, 2, { center: false }).extrude(4, { symmetric: true }))).toEqual({ min: [0, -2, 0], max: [10, 2, 2] });
  expect(box3(() => sketch(plane.XY).rect(10, 2).extrude(-3))).toEqual({ min: [-5, -1, -3], max: [5, 1, 0] });
  expect(box3(() => sketch(plane.XZ).rect(5, 20, { at: [10, 0], center: false }).revolve())).toEqual({ min: [-15, -15, 0], max: [15, 15, 20] });
  expect(box3(() => box(10, 20, 30))).toEqual({ min: [0, 0, 0], max: [10, 20, 30] });
  expect(box3(() => box(10, 20, 30, { center: "xy" }))).toEqual({ min: [-5, -10, 0], max: [5, 10, 30] });
  expect(box3(() => box(10, 20, 30, { center: true }))).toEqual({ min: [-5, -10, -15], max: [5, 10, 15] });
  expect(box3(() => cylinder(3, 20, { at: [10, 0, -5] }))).toEqual({ min: [7, -3, -5], max: [13, 3, 15] });
  expect(box3(() => cylinder(5, 10, { axis: "X" }))).toEqual({ min: [0, -5, -5], max: [10, 5, 5] });
});

test("selectors and filters behave as documented", () => {
  run(part("t", () => {
    const b = sketch(plane.XY, { tag: "plate" }).rect(60, 40, { tag: "outline" }).circle([0, 0], 6, { tag: "bore" }).extrude(5, { tag: "plate" });
    const names = (s: api.EntitySet) => s.names().map((n) => n.replace(/^t\//, "")).sort();
    // edges: |Z straight edges along Z (circles never), #Z straight edges perpendicular to Z
    expect(b.edges("|Z").length).toBe(4);
    expect(b.edges("#Z").length).toBe(8);
    expect(b.edges("|Z").list().every((e) => e.curve === "line")).toBe(true);
    expect(b.edges("%circle").length).toBe(2);
    expect(names(b.edges("bore & >Z"))).toEqual(["(plate · cap.end) & (plate · side · bore)"]);
    // faces: |Z faces facing ±Z plus cylinders about Z; #Z the side walls; +Z / -Z planar faces facing that way
    expect(names(b.faces("|Z"))).toEqual(["plate · cap.end", "plate · cap.start", "plate · side · bore"]);
    expect(names(b.faces().parallelTo("Z"))).toEqual(names(b.faces("|Z")));
    expect(b.faces("#Z").length).toBe(4);
    expect(names(b.faces().perpendicularTo("Z"))).toEqual(names(b.faces("#Z")));
    expect(names(b.faces("+Z"))).toEqual(["plate · cap.end"]);
    expect(names(b.faces("-Z"))).toEqual(["plate · cap.start"]);
    expect(names(b.faces(">Z"))).toEqual(["plate · cap.end"]);
    expect(b.faces().planar().length).toBe(6);
    expect(b.edges().planar().length).toBe(12);
    expect(names(b.faces().filter("%cylinder"))).toEqual(["plate · side · bore"]);
    expect(names(b.faces().filter((f) => f.surface === "cylinder"))).toEqual(["plate · side · bore"]);
    expect(names(b.faces("%plane").sortBy("z", "desc").first())).toEqual(["plate · cap.end"]);
    expect(Math.abs(b.faces().largest().list()[0].normal![2])).toBe(1); // a cap
    expect(b.edges().largest(4).list().every((e) => e.length === 60)).toBe(true);
    return b;
  }));
});

/** Every `@example` in packages/api/src JSDoc (std/ included). */
function examples() {
  const out: { file: string; code: string }[] = [];
  const dir = join(import.meta.dir, "../src");
  for (const f of readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"))) {
    for (const block of readFileSync(join(dir, f), "utf8").match(/\/\*\*[\s\S]*?\*\//g) ?? []) {
      const lines = block.replace(/^\/\*\*|\*\/$/g, "").split("\n").map((l) => l.replace(/^\s*\* ?/, ""));
      for (let i = 0; i < lines.length; i++) {
        const m = /^\s*@example\s?(.*)$/.exec(lines[i]);
        if (!m) continue;
        const code = [m[1]];
        while (i + 1 < lines.length && !/^\s*@\w/.test(lines[i + 1])) code.push(lines[++i]);
        out.push({ file: f, code: code.join("\n").trim() });
      }
    }
  }
  return out;
}

test("every @example in the API docs runs", () => {
  const ex = examples();
  expect(ex.length).toBeGreaterThan(30);
  const apiNames = Object.keys(api);
  const apiValues = apiNames.map((k) => (api as any)[k]);
  const failures: string[] = [];
  for (const { file, code } of ex) {
    let r: ReturnType<typeof run>;
    try {
      if (/export default/.test(code)) {
        // a whole studio
        const def = new Function(...apiNames, code.replace(/^import .*$/gm, "").replace("export default", "return"))(...apiValues);
        r = run(def);
      } else {
        // a snippet, with stand-in solids for the names examples use
        let body: string;
        try {
          new Function(`return (${code}\n)`);
          body = `return (${code}\n);`;
        } catch {
          body = `{\n${code}\n}`;
        }
        r = run(part("t", () => {
          const fixtures = {
            body: box(40, 30, 10, { center: "xy" }).subtract(cylinder(3, 10)),
            base: box(40, 30, 5, { center: "xy" }),
            plate: box(40, 30, 5),
            half: box(10, 20, 5),
            peg: cylinder(2, 5),
            hole: cylinder(2, 10, { at: [20, 0, 0] }),
            boss: cylinder(5, 15),
            rib: box(2, 30, 8, { center: "xy" }),
            lid: box(40, 30, 2, { center: "xy" }).translate([0, 0, 12]),
          };
          const v = new Function(...apiNames, ...Object.keys(fixtures), body)(...apiValues, ...Object.values(fixtures));
          return v instanceof Solid ? v : fixtures.body;
        }));
      }
    } catch (e) {
      failures.push(`${file}: ${code}\n  threw ${(e as Error).message}`);
      continue;
    }
    const errs = errors(r);
    if (errs.length) failures.push(`${file}: ${code}\n  ${errs.join("; ")}`);
  }
  expect(failures).toEqual([]);
});
