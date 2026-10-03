import { expect, test } from "bun:test";
import { Engine } from "../src/engine";
import { findAssemblyScope, withinScope } from "../src/assembly-scope";

test("nested scope membership excludes similarly named siblings and source definitions", () => {
  const e = new Engine();
  e.setDocument({ scripts: {
    "studios/parts.ts": `import { part, box } from "parasocial"; export const base = part("Base", () => box(1, 1, 1)); export const lid = part("Lid", () => box(1, 1, 1));`,
    "studios/hinge.ts": `import { assembly } from "parasocial"; import { base, lid } from "./parts"; export default assembly("Hinge", ({ fix, revolute }) => { fix(base); revolute(base, lid, { origin: [0, 0, 0], axis: "Z" }, { name: "open" }); });`,
    "studios/module.ts": `import { assembly } from "parasocial"; import hinge from "./hinge"; export default assembly("Module", ({ insert, fix }) => fix(insert(hinge, { name: "door" })), { partNumber: "M-100", description: "Door module" });`,
    "studios/rack.ts": `import { assembly } from "parasocial"; import module from "./module"; export default assembly("Rack", ({ insert }) => { insert(module, { name: "left" }); insert(module, { name: "left2" }); });`,
  } });
  const infos = e.assemblies();
  expect(infos.flatMap((a) => a.problems)).toEqual([]);
  const scope = findAssemblyScope(infos, "rack/module@left")!;
  expect(scope.name).toBe("Module left");
  expect(scope.definition).toBe("module");
  expect(scope.partNumber).toBe("M-100");
  expect(scope.description).toBe("Door module");
  expect(scope.assembly.id).toBe("rack");
  expect(scope.instances.map((i) => i.id)).toEqual(["rack/module@left/hinge@door/parts:base", "rack/module@left/hinge@door/parts:lid"]);
  expect(scope.subs.map((s) => s.id)).toEqual(["rack/module@left/hinge@door"]);
  expect(scope.joints.map((j) => j.name)).toEqual(["module@left/hinge@door/open"]);
  expect(findAssemblyScope(infos, "rack/module@left/hinge@door")?.name).toBe("Hinge door");
  expect(findAssemblyScope(infos, "rack")?.instances).toHaveLength(4);
  expect(findAssemblyScope(infos, "rack/module@lef")).toBeUndefined();
  expect(withinScope("rack/module@left2", "rack/module@left")).toBe(false);
});
