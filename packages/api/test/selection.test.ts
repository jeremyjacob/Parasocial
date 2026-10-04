// Entity centers drive nearest(), sortBy("x" | "y" | "z") and the ">Z" extremes.
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

test("a full circle edge's center is the circle's center, wherever its seam is", () => {
  for (const deg of [0, 90, 200]) {
    let body!: Solid;
    // counterbored plate: bore r3 through, counterbore r6 × 2 deep; the seams turn with `deg`
    const r = run("plate", () => {
      const plate = box(40, 40, 5, { center: "xy", tag: "plate" });
      const bore = cylinder(3, 7, { at: [0, 0, -1], tag: "bore" }).rotate(deg);
      const cb = cylinder(6, 3, { at: [0, 0, 3], tag: "cbore" }).rotate(deg);
      return (body = plate.subtract(bore, cb, { tag: "cut" }));
    });
    expect(r.problems.filter((p) => p.severity === "error")).toEqual([]);
    const circles = body.edges("%circle");
    expect(circles.length).toBe(4);
    for (const e of circles.list()) expect(Math.hypot(e.center[0], e.center[1])).toBeLessThan(1e-6);
    // the counterbore's rim, not the bore's top edge 2 below it (its midpoint would be nearer)
    const [rim] = circles.nearest([0, 0, 5]).list();
    expect(rim.radius).toBeCloseTo(6, 9);
    expect(rim.center[2]).toBeCloseTo(5, 9);
    // a plain plate's bore: its top edge by nearest and by sortBy, whatever the seam angle
    let plate!: Solid;
    run("bored", () => (plate = box(40, 40, 5, { center: "xy" }).subtract(cylinder(4, 7, { at: [0, 0, -1] }).rotate(deg))));
    const top = plate.edges("%circle").sortBy("z", "desc").first();
    expect(plate.edges().nearest([0, 0, 5]).names()).toEqual(top.names());
    top.list()[0].center.forEach((c, i) => expect(c).toBeCloseTo([0, 0, 5][i], 9));
    // concentric circles tie on x / y
    expect(circles.groupBy("x").length).toBe(1);
    expect(circles.filter("<Y").length).toBe(4);
  }
});
