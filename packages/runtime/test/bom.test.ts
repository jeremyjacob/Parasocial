import { beforeAll, expect, test } from "bun:test";
import { loadKernel } from "@parasocial/kernel";
import { Engine, computeBom, bomToCSV, bomToMarkdown } from "../src";

beforeAll(async () => {
  await loadKernel();
});

// A plate with screws: the screw is a standard part, declared in two studios under one part number.
const scripts: Record<string, string> = {
  "studios/plate.ts": `import { part, box } from "parasocial";
export default part("Plate", () => box(40, 20, 4), { material: "aluminum", partNumber: "PL-100", description: "Base plate" });`,
  "studios/screw.ts": `import { part, cylinder } from "parasocial";
export default part("M3 screw", () => cylinder(1.5, 10), { material: "steel", partNumber: "ISO4762-M3x10", vendor: "Bossard", standard: true });`,
  "studios/hardware.ts": `import { part, cylinder } from "parasocial";
export const screw = part("M3 screw", () => cylinder(1.5, 10), { material: "steel", partNumber: "ISO4762-M3x10", vendor: "Bossard", standard: true });
export const spacer = part("Spacer", () => cylinder(3, 5));`,
  "studios/module.ts": `import { assembly } from "parasocial";
import plate from "./plate";
import screw from "./screw";
import { screw as screw2, spacer } from "./hardware";
export default assembly("Module", ({ insert, fix }) => {
  fix(plate);
  insert(screw, { place: { translate: [5, 5, 4] } });
  insert(screw, { name: "b", place: { translate: [35, 5, 4] } });
  insert(screw2, { place: { translate: [20, 15, 4] } });
  insert(spacer, { place: { translate: [20, 5, 4] } });
});`,
  "studios/rack.ts": `import { assembly } from "parasocial";
import module from "./module";
import plate from "./plate";
export default assembly("Rack", ({ insert, fix }) => {
  fix(plate);
  insert(module, { name: "left", place: { translate: [0, 30, 0] } });
  insert(module, { name: "right", place: { translate: [0, 60, 0] } });
});`,
};

test("a document BOM lists each part once and points at the assemblies", () => {
  const e = new Engine();
  e.setDocument({ scripts });
  const bom = computeBom(e, { documentName: "Rack" });
  expect(bom.scope).toBe("document");
  // the two screw parts share a part number: one line, quantity 2
  expect(bom.rows.map((r) => [r.name, r.quantity, r.partNumber ?? null])).toEqual([
    ["M3 screw", 2, "ISO4762-M3x10"],
    ["Spacer", 1, null],
    ["Plate", 1, "PL-100"],
  ]);
  expect(bom.rows[0].parts).toEqual(["hardware:screw", "screw"]);
  expect(bom.assemblies?.map((a) => a.id).sort()).toEqual(["module", "rack"]);
});

test("an assembly BOM counts copies, subassemblies included, with material, volume and mass", () => {
  const e = new Engine();
  e.setDocument({ scripts });
  const mod = computeBom(e, { assembly: "module" });
  const row = (b: typeof mod, name: string) => b.rows.find((r) => r.name === name)!;
  expect(row(mod, "Plate").quantity).toBe(1);
  expect(row(mod, "M3 screw").quantity).toBe(3);
  expect(row(mod, "Spacer").quantity).toBe(1);
  expect(row(mod, "M3 screw").instances).toHaveLength(3);

  const rack = computeBom(e, { assembly: "rack" });
  expect(row(rack, "Plate").quantity).toBe(3); // its own + one per module
  expect(row(rack, "M3 screw").quantity).toBe(6);
  expect(row(rack, "Spacer").quantity).toBe(2);
  expect(rack.subassemblies).toEqual([{ assembly: "module", name: "Module", quantity: 2 }]);

  const plate = row(rack, "Plate");
  expect(plate.material).toBe("Aluminum 6061");
  expect(plate.volume).toBeCloseTo(40 * 20 * 4, 3);
  expect(plate.mass).toBeCloseTo(3.2 * 2.7, 3);
  expect(plate.size).toEqual([40, 20, 4].map((v) => expect.closeTo(v, 3)) as any);
  // the spacer has no material: no mass, and the total says so
  expect(row(rack, "Spacer").mass).toBeUndefined();
  expect(rack.totals.massUnknown).toBe(1);
  expect(rack.totals.quantity).toBe(11);
  const screwMass = row(rack, "M3 screw").mass!;
  expect(rack.totals.mass).toBeCloseTo(3 * plate.mass! + 6 * screwMass, 6);
});

test("CSV and Markdown", () => {
  const e = new Engine();
  e.setDocument({ scripts });
  const bom = computeBom(e, { assembly: "module" });
  const csv = bomToCSV(bom).split("\r\n");
  expect(csv[0]).toBe("Item,Part number,Name,Description,Qty,Material,Vendor,Volume (mm³),Mass (g),Size (mm),Part id");
  expect(csv.find((l) => l.includes("M3 screw"))).toMatch(/^\d,ISO4762-M3x10,M3 screw,,3,Steel,Bossard,/);
  const md = bomToMarkdown(bom);
  expect(md).toContain("# Bill of materials: Module");
  expect(md).toContain("| Base plate |");
  expect(md).toMatch(/3 lines, 5 parts, [\d.]+ g \(1 line without a material density not included\)\./);
});

test("unknown assemblies and bad part options are explained", () => {
  const e = new Engine();
  e.setDocument({ scripts });
  expect(() => computeBom(e, { assembly: "nope" })).toThrow(/no assembly "nope"; assemblies: module, rack/);
  const bad = new Engine();
  bad.setDocument({ scripts: { "studios/p.ts": `import { part, box } from "parasocial";\nexport default part("P", () => box(1, 1, 1), { material: "unobtainium" });` } });
  const r = bad.regenerate("p");
  expect(r.ok).toBe(false);
  expect(r.problems[0].message).toContain('unknown material "unobtainium"');
});
