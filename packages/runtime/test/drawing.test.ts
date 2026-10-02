import { beforeAll, expect, test } from "bun:test";
import { loadKernel, box, cylinder, boolean } from "@parasocial/kernel";
import { Engine, drawPart, drawShape } from "../src";
import { Glob } from "bun";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { unzlibSync, strFromU8 } from "fflate";

beforeAll(async () => {
  await loadKernel();
});

function engineFor(dir: string) {
  const root = join(import.meta.dir, "../../../examples", dir);
  const scripts: Record<string, string> = {};
  for (const f of new Glob("{studios,lib}/**/*.ts").scanSync(root)) scripts[f] = readFileSync(join(root, f), "utf8");
  const e = new Engine();
  e.setDocument({ scripts });
  return e;
}

const view = <T extends { name: string }>(r: { views: T[] }, name: string) => r.views.find((v) => v.name === name)!;

test("drawings refresh an already regenerated part after script and override changes", () => {
  const e = engineFor("bracket");
  drawPart(e, "bracket", { views: ["front"] });
  e.setOverrides("bracket", { width: 60 });
  expect(drawPart(e, "bracket", { views: ["front"] }).svg).toContain(">60<");
  const script = e.getScripts()["studios/bracket.ts"];
  e.setScript("studios/bracket.ts", script.replace('part("Bracket"', 'part("New bracket"'));
  expect(drawPart(e, "bracket", { views: ["front"] }).svg).toContain(">New bracket<");
});

test("bracket: third-angle views, hidden lines, a hatched section A–A, dimensions and a title block", () => {
  const e = engineFor("bracket");
  const r = drawPart(e, "bracket", { sections: [{ plane: "front" }], document: "Bracket", version: "v3", date: "2026-01-02" });
  expect(r.warnings).toEqual([]);
  expect(r.sheet).toBe("A4");
  expect(r.scaleLabel).toBe("2:1");
  expect(r.views.map((v) => v.name).sort()).toEqual(["front", "iso", "right", "section A", "top"]);
  // third angle: top above front, right to the right, aligned
  const front = view(r, "front"),
    top = view(r, "top"),
    right = view(r, "right");
  expect(top.at[1]).toBeLessThan(front.at[1]);
  expect(top.at[0]).toBeCloseTo(front.at[0], 6);
  expect(right.at[0]).toBeGreaterThan(front.at[0]);
  expect(right.at[1]).toBeCloseTo(front.at[1], 6);
  // the plate is 40 × 25 × 3, drawn at 2:1
  expect(front.size[0]).toBeCloseTo(80, 1);
  const svg = r.svg!;
  expect(svg.startsWith("<?xml")).toBe(true);
  expect(svg).toContain('width="297mm" height="210mm"');
  expect(svg).toContain("stroke-dasharray"); // hidden lines (the bore, seen from the front)
  expect(svg).toContain('fill="url(#hatch0)"');
  expect(svg).toContain("SECTION A–A");
  for (const t of [">40<", ">25<", ">3<", ">Ø8<", ">Bracket<", ">v3<", ">2026-01-02<", ">2:1<", "THIRD ANGLE PROJECTION"]) expect(svg).toContain(t);
});

test("first-angle projection swaps where the views go", () => {
  const e = engineFor("bracket");
  const r = drawPart(e, "bracket", { projection: "first", views: ["front", "top", "right"] });
  const front = view(r, "front"),
    top = view(r, "top"),
    right = view(r, "right");
  expect(top.at[1]).toBeGreaterThan(front.at[1]);
  expect(right.at[0]).toBeLessThan(front.at[0]);
  expect(r.svg).toContain("FIRST ANGLE PROJECTION");
});

test("a section through a hole leaves it open, and a plane that misses the part is a warning", () => {
  const s = boolean("subtract", box(40, 20, 10).shape, cylinder(4, 30, [20, 10, -5]).shape).shape;
  const r = drawShape(s, { views: ["front"], sections: [{ plane: { origin: [0, 10, 0], normal: [0, -1, 0] } }, { plane: "top", at: 50 }], date: "x" });
  expect(r.views.map((v) => v.name)).toEqual(["front", "section A"]);
  expect(r.warnings.join()).toContain("section B–B misses the part");
  // the cut face is split by the hole: two hatched regions
  expect(r.svg!.match(/fill="url\(#hatch0\)"/g)!.length).toBe(2);
});

test("PDF output is a well-formed one-page PDF with the same content", () => {
  const e = engineFor("bracket");
  const r = drawPart(e, "bracket", { format: "pdf", sections: [{ plane: "right" }], date: "2026-01-02" });
  const pdf = r.pdf!;
  const text = strFromU8(pdf, true);
  expect(text.startsWith("%PDF-1.4")).toBe(true);
  expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
  // xref offsets point at their objects
  const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
  expect(text.slice(xref, xref + 4)).toBe("xref");
  const offsets = [...text.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  expect(offsets.length).toBe(7);
  offsets.forEach((o, i) => expect(text.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
  // the content stream draws text and dashed lines
  const start = text.indexOf("stream\n") + 7;
  const len = Number(/\/Length (\d+)/.exec(text)![1]);
  const content = strFromU8(unzlibSync(pdf.subarray(start, start + len)), true);
  expect(content).toContain("(SECTION A");
  expect(content).toContain("(Bracket) Tj");
  expect(content).toMatch(/\[2 1\] 0 d/);
  expect(content).toContain("W* n"); // hatching clipped to the cut face
});

test("every example part draws", () => {
  for (const d of ["bracket", "flange", "enclosure", "knob", "gasket", "hinge", "lamp"]) {
    const e = engineFor(d);
    for (const p of e.parts()) {
      const r = drawPart(e, p, { sections: [{ plane: "front" }] });
      expect(r.svg!.length).toBeGreaterThan(1000);
      expect(r.views.length).toBe(5);
    }
  }
}, 60_000);

test("bad input is explained", () => {
  const e = engineFor("bracket");
  expect(() => drawPart(e, "nope")).toThrow(/no part "nope"; parts: bracket/);
  expect(() => drawPart(e, "bracket", { views: ["side" as any] })).toThrow(/unknown view "side"/);
  expect(() => drawPart(e, "bracket", { sheet: "B5" as any })).toThrow(/unknown sheet/);
  // an explicit scale that doesn't fit is drawn anyway, with a warning
  const r = drawPart(e, "bracket", { scale: 10 });
  expect(r.scaleLabel).toBe("10:1");
  expect(r.warnings.join()).toContain("don't fit");
});
