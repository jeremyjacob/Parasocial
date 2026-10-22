import { describe, expect, test } from "bun:test";
import { Engine } from "../src/engine";

const parts = `import { part, box } from "parasocial";
export const base = part("Base", () => box(40, 40, 5).connector("top", { origin: [0, 0, 5], axis: [0, 0, 1] }));
export const lid = part("Lid", () => box(40, 40, 2).translate([0, 0, 20]));
export const screw = part("Screw", () => box(2, 2, 8).connector("axis", { origin: [0, 0, 0], axis: [0, 0, -1] }));
export const wheel = part("Wheel", () => box(10, 10, 10));
export const knob = part("Knob", () => box(3, 3, 3));`;
const axle = `import { assembly } from "parasocial";
import { base, wheel } from "./parts";
export default assembly("Axle", ({ insert, fastened }) => { fastened(base, insert(wheel, { name: "left" }), { origin: [0, 0, 0], axis: "Z" }); fastened(base, insert(wheel, { name: "right" }), { origin: [0, 0, 0], axis: "Z" }); });`;
const box = `import { assembly } from "parasocial";
import { base, lid, screw } from "./parts";
import axle from "./axle";
export default assembly("Box", ({ insert, fastened, fix }) => {
  fix(base);
  fastened(base, lid, { origin: [0, 0, 5], axis: "Z" });
  for (const n of ["a", "b", "c"]) fastened(lid, insert(screw, { name: n }), { origin: [0, 0, 20], axis: "Z" });
  insert(axle, { name: "front" });
});`;

const engine = (build: string, extra: Record<string, string> = {}) => {
  const e = new Engine();
  e.setDocument({ scripts: { "studios/parts.ts": parts, "studios/axle.ts": axle, "studios/box.ts": box, "builds/box.ts": build, ...extra } });
  return e;
};

describe("build steps", () => {
  test("steps resolve to the assembly's copies: a part is its remaining copies, a subassembly moves as one", () => {
    const e = engine(`import { buildSteps } from "parasocial";
import box from "../studios/box";
import axle from "../studios/axle";
import { base, lid, screw, wheel } from "../studios/parts";
export default buildSteps(box, ({ step, copy, sub }) => {
  step("Set down the base", base);
  step("First screw", copy(screw, "a"), { along: screw.at("axis"), turn: 360 });
  step("Close the lid", lid, { from: [[0, 30, 40], [0, 0, 40]], description: "Lower it on" });
  step("The rest of the screws", screw, { stagger: 0.2, along: "Z", distance: 12 });
  step("Left wheel", sub(axle, "front").part(wheel, "left"));
  step("The axle", sub(axle, "front"));
});`);
    const [b] = e.builds();
    expect(b.problems).toEqual([]);
    expect(b.id).toBe("box");
    expect(b.assembly).toBe("box");
    expect(b.name).toBe("Box");
    expect(b.steps.map((s) => [s.title, s.parts])).toEqual([
      ["Set down the base", ["box/parts:base"]],
      ["First screw", ["box/parts:screw@a"]],
      ["Close the lid", ["box/parts:lid"]],
      ["The rest of the screws", ["box/parts:screw@b", "box/parts:screw@c"]],
      ["Left wheel", ["box/axle@front/parts:wheel@left"]],
      ["The axle", ["box/axle@front/parts:base", "box/axle@front/parts:wheel@right"]],
    ]);
    // a connector of the moving part: each copy uses its own
    expect(b.steps[1].along).toEqual({ part: "parts:screw", connector: "axis" });
    expect(b.steps[1].turn).toBe(360);
    expect(b.steps[2].from).toEqual([[0, 30, 40], [0, 0, 40]]);
    expect(b.steps[2].description).toBe("Lower it on");
    expect(b.steps[3]).toMatchObject({ along: { axis: [0, 0, 1] }, distance: 12, stagger: 0.2 });
    expect(b.steps[5].units).toEqual([["box/axle@front/parts:base", "box/axle@front/parts:wheel@right"]]);
    expect(b.steps[3].units).toBeUndefined();
    expect(b.steps[4].source?.file).toBe("builds/box.ts");
  });

  test("copies no step names come in last, with a warning", () => {
    const e = engine(`import { buildSteps } from "parasocial";
import box from "../studios/box";
import { base } from "../studios/parts";
export default buildSteps(box, ({ step }) => { step("Base", base); step("Base again", base); });`);
    const [b] = e.builds();
    expect(b.steps.at(-1)).toMatchObject({ auto: true, title: "Add the remaining parts" });
    expect(b.steps.at(-1)!.parts).toHaveLength(7);
    expect(b.problems.map((p) => p.severity)).toEqual(["warning", "warning"]);
    expect(b.problems[0].message).toContain("earlier step");
    expect(b.problems[1].message).toContain("7 copies aren't in any step");
  });

  test("misuse is a problem at the script line", () => {
    const e = engine(`import { buildSteps } from "parasocial";
import box from "../studios/box";
import { base } from "../studios/parts";
export default buildSteps(box, ({ step }) => {
  step("Base", base, { from: [0, 0, 1], along: "Z" });
});`);
    const [b] = e.builds();
    expect(b.problems).toHaveLength(1);
    expect(b.problems[0].message).toContain("not both");
    expect(b.problems[0].source).toMatchObject({ file: "builds/box.ts", line: 5 });
  });

  test("a part outside the assembly, a missing copy, a file that doesn't load", () => {
    const missing = engine(`import { buildSteps } from "parasocial";
import box from "../studios/box";
import { knob, screw } from "../studios/parts";
export default buildSteps(box, ({ step, copy }) => { step("Knob", knob); step("Screw", copy(screw, "z")); });`);
    const msgs = missing.builds()[0].problems.filter((p) => p.severity === "error").map((p) => p.message);
    expect(msgs[0]).toContain(`"Knob" isn't in "Box"`);
    expect(msgs[1]).toContain(`has no copy Screw "z"`);
    const broken = engine(`import { buildSteps } from "parasocial"; export default buildSteps(`);
    expect(broken.builds()[0].problems[0].severity).toBe("error");
    // a broken build script never breaks the parts
    expect(broken.parts()).toEqual(["parts:base", "parts:lid", "parts:screw", "parts:wheel", "parts:knob"]);
  });

  test("a subassembly built on its own first: its steps, then the step that mounts it", () => {
    const e = engine(`import { buildSteps } from "parasocial";
import box from "../studios/box";
import axle from "../studios/axle";
import { base, lid, screw, wheel } from "../studios/parts";
export default buildSteps(box, ({ step, sub }) => {
  step("Set down the base", base);
  step("Mount the axle", sub(axle, "front"), {
    from: [0, 0, 30],
    build: ({ step, copy }) => {
      step("Axle beam", base);
      step("Left wheel", copy(wheel, "left"), { along: "X", distance: 20 });
    },
  });
  step("The rest", [lid, screw]);
});`);
    const [b] = e.builds();
    expect(b.problems.map((p) => p.message)).toEqual([expect.stringContaining(`step("Mount the axle"): build: 1 copy isn't in any step (parts:wheel@right)`)]);
    expect(b.stages).toEqual([{ id: "box/axle@front", assembly: "axle", name: 'Axle "front"', copies: ["box/axle@front"] }]);
    expect(b.steps.map((s) => [s.title, s.parts, s.stage, s.mount])).toEqual([
      ["Set down the base", ["box/parts:base"], undefined, undefined],
      ["Axle beam", ["box/axle@front/parts:base"], "box/axle@front", undefined],
      ["Left wheel", ["box/axle@front/parts:wheel@left"], "box/axle@front", undefined],
      ["Add the remaining parts", ["box/axle@front/parts:wheel@right"], "box/axle@front", undefined],
      ["Mount the axle", ["box/axle@front/parts:wheel@left", "box/axle@front/parts:base", "box/axle@front/parts:wheel@right"], undefined, "box/axle@front"],
      ["The rest", ["box/parts:lid", "box/parts:screw@a", "box/parts:screw@b", "box/parts:screw@c"], undefined, undefined],
    ]);
    expect(b.steps[2]).toMatchObject({ along: { axis: [1, 0, 0] }, distance: 20 });
    expect(b.steps[3].auto).toBe(true);
    expect(b.steps[4]).toMatchObject({ from: [[0, 0, 30]], units: [b.steps[4].parts] });
  });

  test("a subassembly's own build script, reused; copies of it built once and mounted together", () => {
    const axleBuild = `import { buildSteps } from "parasocial";
import axle from "../studios/axle";
import { base, wheel } from "../studios/parts";
export default buildSteps(axle, ({ step }) => { step("Beam", base); step("Wheels", wheel, { stagger: 0.2 }); });`;
    const cart = `import { assembly } from "parasocial";
import { lid } from "./parts";
import axle from "./axle";
export default assembly("Cart", ({ insert, fix }) => { fix(lid); insert(axle, { name: "front" }); insert(axle, { name: "rear" }); });`;
    const e = engine(
      `import { buildSteps } from "parasocial";
import cart from "../studios/cart";
import axle from "../studios/axle";
import axleSteps from "./axle";
import { lid } from "../studios/parts";
export default buildSteps(cart, ({ step, sub }) => {
  step("Deck", lid);
  step("Mount the axles", [sub(axle, "front"), sub(axle, "rear")], { from: [0, 0, -30], stagger: 0.3, build: axleSteps });
});`,
      { "builds/axle.ts": axleBuild, "studios/cart.ts": cart },
    );
    const builds = e.builds();
    const axleOwn = builds.find((b) => b.id === "axle")!;
    expect(axleOwn.steps.map((s) => s.title)).toEqual(["Beam", "Wheels"]);
    const b = builds.find((b) => b.id === "box")!;
    expect(b.problems).toEqual([]);
    expect(b.stages).toEqual([{ id: "cart/axle@front", assembly: "axle", name: "Axle", copies: ["cart/axle@front", "cart/axle@rear"] }]);
    expect(b.steps.map((s) => [s.title, s.parts.length, s.stage ?? null])).toEqual([
      ["Deck", 1, null],
      ["Beam", 1, "cart/axle@front"],
      ["Wheels", 2, "cart/axle@front"],
      ["Mount the axles", 6, null],
    ]);
    expect(b.steps[2].source?.file).toBe("builds/axle.ts");
    expect(b.steps[3].units?.map((u) => u.length)).toEqual([3, 3]);
    expect(b.steps[3].mount).toBe("cart/axle@front");
  });

  test("build goes with a subassembly, and with steps for that subassembly", () => {
    const onPart = engine(`import { buildSteps } from "parasocial";
import box from "../studios/box";
import { base } from "../studios/parts";
export default buildSteps(box, ({ step }) => { step("Base", base, { build: () => {} }); });`);
    expect(onPart.builds()[0].problems[0].message).toContain("build goes with a subassembly");
    const wrong = engine(`import { buildSteps } from "parasocial";
import box from "../studios/box";
import axle from "../studios/axle";
import { base } from "../studios/parts";
const other = buildSteps(box, ({ step }) => step("Base", base));
export default buildSteps(box, ({ step, sub }) => { step("Axle", sub(axle, "front"), { build: other }); });`);
    expect(wrong.builds().find((b) => b.export === "default")!.problems[0].message).toContain(`those steps build "Box", not "Axle"`);
  });
});
