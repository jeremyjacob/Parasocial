// thicken(): planar, multi-face (sharp corners), cylindrical and freeform faces, both directions,
// with volumes, names and friendly errors.
import { beforeAll, expect, test } from "bun:test";
import { loadKernel } from "@parasocial/kernel";
import { OpCache, names } from "@parasocial/naming";
import { PartContext, runPart } from "../src/internal";
import { part, param, box, cylinder, sketch, plane, loft, thicken, measure, type Solid } from "../src";

beforeAll(async () => {
  await loadKernel();
});

const run = (name: string, fn: () => Solid, overrides: Record<string, number> = {}) => {
  const cache = new OpCache();
  cache.begin();
  return runPart(part(name, fn), new PartContext({ part: name, file: `studios/${name}.ts`, cache, overrides }));
};

/** Thicken inside a part; the result solid plus the run's problems. */
function thick(fn: () => Solid) {
  let s!: Solid;
  const r = run("t", () => (s = fn()));
  expect(r.problems.filter((p) => p.severity === "error")).toEqual([]);
  expect(s.isValid()).toBe(true);
  return s;
}
const near = (a: number, b: number, rel = 1e-6) => expect(Math.abs(a - b) / Math.abs(b)).toBeLessThan(rel);
const faceNames = (s: Solid) => names((s as any).record, "face").map((n) => n.str);

test("a planar face from a solid thickens both ways (the reported bug)", () => {
  const up = thick(() => thicken(box(40, 30, 5).faces(">Z"), 2));
  near(up.volume(), 40 * 30 * 2);
  expect(up.boundingBox().min[2]).toBeCloseTo(5, 6);
  expect(up.boundingBox().max[2]).toBeCloseTo(7, 6);
  const down = thick(() => thicken(box(40, 30, 5).faces(">Z"), -2));
  near(down.volume(), 40 * 30 * 2);
  expect(down.boundingBox().min[2]).toBeCloseTo(3, 6);
  expect(down.boundingBox().max[2]).toBeCloseTo(5, 6);
  // a side face (normal -X) and a face of a part with other features
  const side = thick(() => thicken(box(40, 30, 5).faces("<X"), 1.5));
  near(side.volume(), 30 * 5 * 1.5);
  expect(side.boundingBox().min[0]).toBeCloseTo(-1.5, 6);
  const holed = thick(() => thicken(box(40, 30, 5).subtract(cylinder(3, 5, { at: [20, 15, 0] })).faces(">Z"), 2));
  near(holed.volume(), (40 * 30 - Math.PI * 9) * 2);
});

test("adjacent planar faces join with square corners", () => {
  // top + right of a box: an L
  near(thick(() => thicken(box(40, 30, 5).faces(">Z or >X"), 2)).volume(), 40 * 30 * 2 + 30 * 5 * 2 + 2 * 2 * 30);
  near(thick(() => thicken(box(40, 30, 5).faces(">Z or >X"), -2)).volume(), 40 * 30 * 2 + 30 * 5 * 2 - 2 * 2 * 30);
  // a box's open shell (all but the bottom)
  const open = () => box(40, 30, 5).faces("not <Z");
  const out = thick(() => thicken(open(), 2));
  near(out.volume(), 44 * 34 * 7 - 40 * 30 * 5);
  expect(out.boundingBox().min).toEqual(expect.arrayContaining([expect.closeTo(-2, 6)]));
  near(thick(() => thicken(open(), -2)).volume(), 40 * 30 * 5 - 36 * 26 * 3);
});

test("separate faces thicken separately and fuse", () => {
  near(thick(() => thicken(box(40, 30, 5).faces(">Z or <Z"), 2)).volume(), 2 * 40 * 30 * 2);
  // inward slabs of a 3 mm plate overlap: one solid, the whole plate
  const both = thick(() => thicken(box(40, 30, 3).faces(">Z or <Z"), -2));
  near(both.volume(), 40 * 30 * 3);
});

test("cylindrical faces, with and without a cap", () => {
  near(thick(() => thicken(cylinder(10, 20).faces("%cylinder"), 1)).volume(), Math.PI * (11 ** 2 - 10 ** 2) * 20);
  near(thick(() => thicken(cylinder(10, 20).faces("%cylinder"), -1)).volume(), Math.PI * (10 ** 2 - 9 ** 2) * 20);
  near(thick(() => thicken(cylinder(10, 20).faces("not <Z"), 2)).volume(), Math.PI * (12 ** 2 - 10 ** 2) * 20 + Math.PI * 12 ** 2 * 2);
  near(thick(() => thicken(cylinder(10, 20).faces("not <Z"), -2)).volume(), Math.PI * (10 ** 2 - 8 ** 2) * 18 + Math.PI * 10 ** 2 * 2);
});

test("a freeform (lofted) face thickens both ways", () => {
  const vase = () => loft([sketch(plane.XY).circle([0, 0], 10), sketch(plane.XY.offset(10)).circle([0, 0], 6), sketch(plane.XY.offset(20)).circle([0, 0], 10)]);
  let area = 0;
  run("a", () => {
    const v = vase();
    area = measure.area(v.faces("not %plane"));
    return v;
  });
  for (const t of [0.5, -0.5]) {
    const s = thick(() => thicken(vase().faces("not %plane"), t));
    // a thin skin: volume ≈ area × thickness (the waist is concave one way, convex the other)
    expect(Math.abs(s.volume() - area * Math.abs(t)) / (area * Math.abs(t))).toBeLessThan(0.05);
  }
});

test("thickened skins union onto their part", () => {
  let s!: Solid;
  const r = run("u", () => {
    const b = box(40, 30, 5);
    return (s = b.union(thicken(b.faces(">Z"), 2)));
  });
  expect(r.problems).toEqual([]);
  near(s.volume(), 40 * 30 * 7);
});

test("faces are named: selected faces keep theirs, offsets and side walls get roles", () => {
  const s = thick(() => thicken(box(40, 30, 5, { tag: "plate" }).faces(">Z or >X"), 2, { tag: "skin" }));
  const n = faceNames(s).sort();
  expect(n).toContain("t/plate · zmax");
  expect(n).toContain("t/plate · xmax");
  expect(n).toContain("t/skin · offset · (t/plate · zmax)");
  expect(n).toContain("t/skin · offset · (t/plate · xmax)");
  expect(n.filter((x) => x.startsWith("t/skin · side")).length).toBe(4);
  // no wall borrows the name of an unselected box face
  expect(n.filter((x) => /^t\/plate · (xmin|ymin|ymax|zmin)$/.test(x))).toEqual([]);
  let counts: number[] = [];
  run("t", () => {
    const t = thicken(box(40, 30, 5, { tag: "plate" }).faces(">Z"), 2, { tag: "skin" });
    counts = [t.faces("offset").length, t.faces("side").length, t.faces("skin.offset").length];
    return t;
  });
  expect(counts).toEqual([1, 4, 1]);
});

test("names are stable across parameter changes", () => {
  const body = () => {
    const w = param("w", 40, { min: 10, max: 100 });
    return thicken(box(w, 30, 5, { tag: "plate" }).faces(">Z or >X"), 2, { tag: "skin" });
  };
  const namesFor = (w: number) => {
    let s!: Solid;
    const r = run("t", () => (s = body()), { w });
    expect(r.problems).toEqual([]);
    return faceNames(s).sort();
  };
  const want = namesFor(40);
  expect(namesFor(20)).toEqual(want);
  expect(namesFor(90)).toEqual(want);
});

test("impossible thicknesses are friendly script errors, never raw OCCT exceptions", () => {
  const r = run("e", () => thicken(cylinder(5, 10).faces("%cylinder"), -6));
  expect(r.ok).toBe(false);
  const p = r.problems[0];
  expect(p.message).not.toContain("WebAssembly");
  expect(p.message).not.toContain("[object");
  expect(p.message).toContain("thicken");
  expect(p.op?.type).toBe("thicken");
  expect(p.highlight?.kind).toBe("face");
});
