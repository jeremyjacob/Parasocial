import { beforeAll, expect, test } from "bun:test";
import { loadKernel, meshTransferables } from "@parasocial/kernel";
import { Engine, LatestWins } from "../src";
import { Glob } from "bun";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";

beforeAll(async () => { await loadKernel(); });

test("modeling from a washer's bounds gives identical cold and warm geometry", () => {
  const e = new Engine();
  e.setDocument({ scripts: { "studios/a.ts": `import { part, std } from "parasocial";
export default part("Clamp", () => {
  const washer = std.washer("M3");
  return std.screw("M3", 5, { standard: "ISO7380" })
    .translate([0, 0, washer.boundingBox().size[2]])
    .union(washer, std.insert("M3x4"));
});` } });
  const cold = e.regenerate("a");
  const warm = e.regenerate("a");
  expect(cold.ok).toBe(true);
  expect(warm.ok).toBe(true);
  expect(warm.key).toBe(cold.key);
  expect(warm.bbox).toEqual(cold.bbox);
  expect(warm.mass).toEqual(cold.mass);
});

test("cached derived geometry survives transfer, quality changes and fresh overrides/materials", () => {
  const e = new Engine();
  const script = `import { part, box, param, mm } from "parasocial";
export default part("Box", () => box(param("width", 10, { unit: mm }), 20, 30), { material: { name: "A", density: 1 } });`;
  e.setDocument({ scripts: { "studios/a.ts": script } });
  const fine = e.regenerate("a");
  const positions = [...fine.mesh!.positions];
  structuredClone(fine, { transfer: meshTransferables(fine.mesh!) });
  expect(fine.mesh!.positions.byteLength).toBe(0);
  const coarse = e.regenerate("a", "coarse");
  expect(coarse.mass).toBeUndefined();
  const again = e.regenerate("a");
  expect([...again.mesh!.positions]).toEqual(positions);
  expect(again.mass!.volume).toBeCloseTo(6000, 4);
  again.bbox!.max[0] = 999;
  again.faceEdges[0].length = 0;
  const unmodified = e.regenerate("a");
  expect(unmodified.bbox!.max[0]).toBeLessThan(11);
  expect(unmodified.faceEdges[0].length).toBeGreaterThan(0);
  e.setOverrides("a", { width: 15 });
  const wider = e.regenerate("a");
  expect(wider.mass!.volume).toBeCloseTo(9000, 4);
  e.setScript("studios/a.ts", script.replace('density: 1', 'density: 2'));
  const heavier = e.regenerate("a");
  expect(heavier.key).toBe(wider.key);
  expect(heavier.mass!.mass).toBeCloseTo(wider.mass!.mass * 2, 4);
});

test("collision bounds and cached volumes follow poses and changed geometry", () => {
  const e = new Engine();
  e.setDocument({ scripts: { "studios/a.ts": `import { part, box, param, mm } from "parasocial";
export default part("A", () => box(param("width", 10, { unit: mm }), 10, 10));
export const b = part("B", () => box(10, 10, 10));` } });
  e.regenerate("a"); e.regenerate("a:b");
  const r = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const pose = (x: number) => ({ r, t: [x, 0, 0] as [number, number, number] });
  e.setPoses({ "a:b": pose(5) });
  expect(e.interference("a", "a:b")).toBeCloseTo(500, 4);
  expect(e.interference("a", "a:b")).toBeCloseTo(500, 4);
  e.setPoses({ "a:b": pose(5.0001) });
  expect(e.interference("a", "a:b")).toBeCloseTo(499.99, 4);
  e.setPoses({ "a:b": pose(1000) });
  expect(e.interference("a", "a:b")).toBe(0);
  e.setPoses({ "a:b": pose(5) });
  e.setOverrides("a", { width: 20 }); e.regenerate("a");
  expect(e.interference("a", "a:b")).toBeCloseTo(1000, 4);
});

function docFrom(dir: string) {
  const root = join(import.meta.dir, "../../../examples", dir);
  const scripts: Record<string, string> = {};
  for (const f of new Glob("{studios,lib}/**/*.ts").scanSync(root)) scripts[f] = readFileSync(join(root, f), "utf8");
  return scripts;
}

test("regenerates every example from script sources", () => {
  for (const d of ["bracket", "flange", "enclosure", "knob", "gasket"]) {
    const e = new Engine();
    e.setDocument({ scripts: docFrom(d) });
    for (const p of e.parts()) {
      const r = e.regenerate(p);
      expect(r.problems.filter((x) => x.severity === "error")).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.mesh!.indices.length).toBeGreaterThan(0);
      expect(r.faces.length * 2).toBe(r.mesh!.faceRanges.length);
    }
  }
});

test("provenance maps to script lines, including helper chains", () => {
  const e = new Engine();
  e.setDocument({ scripts: docFrom("flange") });
  e.regenerate("flange");
  const names = e.names("flange");
  const bolt = names.face.findIndex((n) => n.startsWith("flange/bolt ·"));
  const d = e.describe("flange", "face", bolt);
  expect(d.createdBy?.source?.file).toBe("lib/holes.ts");
  expect(d.createdBy?.source?.line).toBe(5);
  expect(d.createdBy?.chain?.map((c) => c.file)).toEqual(["studios/flange.ts", "lib/holes.ts"]);
});

test("syntax and runtime errors carry file:line; last good geometry stays", () => {
  const e = new Engine();
  const scripts = docFrom("bracket");
  e.setDocument({ scripts });
  expect(e.regenerate("bracket").ok).toBe(true);
  e.setScript("studios/bracket.ts", scripts["studios/bracket.ts"].replace("const w =", "const w = ="));
  const r = e.regenerate("bracket");
  expect(r.ok).toBe(false);
  expect(r.problems[0].kind).toBe("syntax");
  expect(r.problems[0].source?.line).toBe(7);
  expect(r.partial).toBe(true);
  expect(r.mesh).toBeDefined(); // last good geometry
  e.setScript("studios/bracket.ts", scripts["studios/bracket.ts"].replace(".chamfer(", ".nope("));
  const r2 = e.regenerate("bracket");
  expect(r2.problems[0].kind).toBe("runtime");
  expect(r2.problems[0].message).toContain("bracket.ts:16");
  // op failure: huge fillet -> actionable message + highlighted edges + partial result
  e.setScript("studios/bracket.ts", scripts["studios/bracket.ts"].replace(', 2, { tag: "corners" }', ', 30, { tag: "corners" }'));
  const r3 = e.regenerate("bracket");
  expect(r3.problems[0].kind).toBe("operation");
  expect(r3.problems[0].message).toMatch(/fillet radius 30 exceeds adjacent face width \d+.*\(bracket\.ts:15\)/);
  expect(r3.problems[0].highlight?.names.length).toBe(4);
  expect(r3.partial).toBe(true);
  expect(r3.mesh).toBeDefined();
});

test("sandbox hygiene: shadowed globals, seeded random, no foreign imports", async () => {
  const e = new Engine();
  e.setDocument({
    scripts: {
      "studios/a.ts": `import { part, box } from "parasocial";
export default part("A", () => {
  if (typeof fetch !== "undefined" || typeof globalThis !== "undefined" || typeof self !== "undefined") throw new Error("leak");
  const w = 10 + Math.floor(Math.random() * 10);
  if (Date.now() !== ${Date.UTC(2024, 0, 1)}) throw new Error("date");
  return box(w, 5, 5);
});`,
      "studios/b.ts": `import x from "lodash"; export default x;`,
      "studios/c.ts": `import { part, box, Solid } from "parasocial";
export default part("C", () => { (Solid.prototype as any).evil = 1; return box(1,1,1); });`,
    },
  });
  const a1 = e.regenerate("a");
  expect(a1.problems).toEqual([]);
  const a2 = e.regenerate("a");
  expect(a2.bbox).toEqual(a1.bbox); // deterministic
  const b = e.regenerate("b");
  expect(b.problems[0].message).toContain('import "lodash" is not allowed');
  e.regenerate("c");
  const { Solid } = await import("@parasocial/api");
  expect((Solid.prototype as any).evil).toBeUndefined(); // frozen API: the write is ignored
});

test("latest-wins scheduler never cancels, skips superseded requests", async () => {
  const ran: number[] = [];
  const lw = new LatestWins<number, number>(async (n) => {
    ran.push(n);
    await Bun.sleep(5);
    return n * 10;
  });
  const p1 = lw.request("p", 1);
  const p2 = lw.request("p", 2);
  const p3 = lw.request("p", 3);
  expect(await p1).toBe(10);
  expect(await p2).toBeNull();
  expect(await p3).toBe(30);
  expect(ran).toEqual([1, 3]);
});

test("budgets: warm param change < 100 ms, cold regen < 2 s (engine only)", () => {
  const e = new Engine();
  e.setDocument({ scripts: docFrom("bracket") });
  const cold = e.regenerate("bracket");
  expect(cold.timings.total).toBeLessThan(2000);
  e.regenerate("bracket");
  e.setOverrides("bracket", { width: 55 });
  const warm = e.regenerate("bracket", "coarse");
  console.log("bracket cold", cold.timings.total.toFixed(1), "warm param", warm.timings.total.toFixed(1), warm.timings);
  expect(warm.timings.total).toBeLessThan(100);
});

test("pack/unpack round-trips a regeneration result", async () => {
  const { packResult, unpackResult, derivedKey } = await import("../src/pack");
  const e = new Engine();
  e.setDocument({ scripts: docFrom("bracket") });
  const r = e.regenerate("bracket");
  const back = unpackResult(packResult({ ...r, names: { face: e.names("bracket").face, edge: [] } }))!;
  expect(back.faces).toEqual(JSON.parse(JSON.stringify(r.faces)));
  expect([...back.mesh!.indices]).toEqual([...r.mesh!.indices]);
  expect([...back.mesh!.edgeRanges]).toEqual([...r.mesh!.edgeRanges]);
  expect(back.names!.face.length).toBe(r.faces.length);
  const k1 = await derivedKey({ part: "bracket", scripts: { "studios/a.ts": "x" }, overrides: { w: 1 }, build: "b" });
  const k2 = await derivedKey({ part: "bracket", scripts: { "studios/a.ts": "x" }, overrides: { w: 2 }, build: "b" });
  expect(k1).not.toBe(k2);
});

test("describeAll, interference, exports", () => {
  const e = new Engine();
  e.setDocument({ scripts: docFrom("enclosure") });
  expect(e.parts()).toEqual(["enclosure", "enclosure:lid", "mount"]);
  for (const p of e.parts()) e.regenerate(p);
  const d = e.describeAll("enclosure");
  expect(d.faces.length).toBeGreaterThan(10);
  expect(d.faces[0].createdBy?.source?.file).toBe("studios/enclosure.ts");
  expect(e.describeAll("enclosure:lid").faces[0].createdBy?.source?.file).toBe("studios/enclosure.ts");
  expect(e.interference("enclosure", "enclosure:lid")).toBeGreaterThanOrEqual(0);
  expect(e.interference("enclosure", "mount")).toBeGreaterThanOrEqual(0);
  for (const f of ["step", "stl", "3mf"] as const) expect(e.exportPart("enclosure", f).byteLength).toBeGreaterThan(100);
});

test("mesh exports are welded and watertight; STL is binary", () => {
  const e = new Engine();
  e.setDocument({ scripts: docFrom("knob") });
  e.regenerate("knob");
  const model = strFromU8(unzipSync(e.exportPart("knob", "3mf"))["3D/3dmodel.model"]);
  const tris = [...model.matchAll(/v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)].map((m) => [+m[1], +m[2], +m[3]]);
  const directed = new Set<string>();
  for (const [a, b, c] of tris) for (const [u, v] of [[a, b], [b, c], [c, a]]) {
    expect(directed.has(`${u},${v}`)).toBe(false); // consistently oriented
    directed.add(`${u},${v}`);
  }
  for (const k of directed) expect(directed.has(k.split(",").reverse().join(","))).toBe(true); // closed: no open edges
  expect(model).not.toMatch(/="-?\d+\.\d{5,}"/); // no float32 noise digits
  const stl = e.exportPart("knob", "stl");
  const n = new DataView(stl.buffer, stl.byteOffset).getUint32(80, true);
  expect(n).toBe(tris.length);
  expect(stl.byteLength).toBe(84 + 50 * n);
});

test("adopted shapes (another worker's parts) answer cross-part requests like local ones", () => {
  const local = new Engine();
  local.setDocument({ scripts: docFrom("enclosure") });
  for (const p of local.parts()) local.regenerate(p);
  // `hub` regenerates only the enclosure; the lid and mount come from `other` as B-rep
  const hub = new Engine(),
    other = new Engine();
  hub.setDocument({ scripts: docFrom("enclosure") });
  other.setDocument({ scripts: docFrom("enclosure") });
  hub.regenerate("enclosure");
  for (const p of ["enclosure:lid", "mount"]) {
    other.regenerate(p);
    const s = other.shapeOf(p)!;
    expect(s.key).toBe(local.shown(p)!.key);
    hub.adopt(p, s.key, s.brep);
  }
  const pose = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [3, 0, 2] as [number, number, number] };
  for (const e of [local, hub]) e.setPoses({ mount: pose });
  expect(hub.interference("enclosure", "mount")).toBeCloseTo(local.interference("enclosure", "mount"), 6);
  expect(hub.interferences(["enclosure", "enclosure:lid", "mount"]).map((i) => [i.a, i.b, i.volume])).toEqual(local.interferences(["enclosure", "enclosure:lid", "mount"]).map((i) => [i.a, i.b, i.volume]));
  // entity indices survive the round trip
  const faces = local.describeAll("mount").faces.length;
  for (const index of [0, Math.floor(faces / 2), faces - 1]) {
    const a = { part: "enclosure", kind: "face" as const, index: 0 },
      b = { part: "mount", kind: "face" as const, index };
    expect(hub.measure(a, b).distance).toBeCloseTo(local.measure(a, b).distance, 9);
  }
  expect(hub.exportParts(["enclosure", "mount"], "step").byteLength).toBeGreaterThan(100);
  expect(hub.exportParts(["enclosure:lid", "mount"], "3mf").byteLength).toBeGreaterThan(1000);
  // regenerating a part here drops the adopted copy
  hub.regenerate("mount");
  expect(hub.measure({ part: "enclosure", kind: "part" }, { part: "mount", kind: "part" }).distance).toBeCloseTo(local.measure({ part: "enclosure", kind: "part" }, { part: "mount", kind: "part" }).distance, 9);
});

test("tangent chain and loop", () => {
  const e = new Engine();
  e.setDocument({ scripts: docFrom("bracket") });
  e.regenerate("bracket");
  const names = e.names("bracket").edge;
  // an edge on the top face boundary: straight edge tangent to the fillet arcs -> the whole outline
  const i = names.findIndex((n) => n.includes("cap.end") && n.includes("outline/right") && !n.includes("fillet"));
  const chain = e.tangentChain("bracket", i);
  expect(chain.length).toBe(8);
  const loop = e.loopOf("bracket", i);
  expect(loop.length).toBe(8);
});

test("a studio exports several parts: default is <stem>, named exports are <stem>:<name>", () => {
  const e = new Engine();
  e.setDocument({
    scripts: {
      "studios/case.ts": `import { part, box } from "parasocial";
export const name = "Case";
export default part("Base", () => box(20, 20, 5));
export const lid = part("Lid", () => box(20, 20, 2));
export const clip = part("Clip", () => box(4, 2, 2));`,
      // builds on a part from another studio and re-exports it: listed once, under case.ts
      "studios/stack.ts": `import { part, box } from "parasocial";
import { lid } from "./case";
export { lid };
export const shim = part("Shim", () => box(20, 20, 1));`,
      "studios/lone.ts": `import { part, box } from "parasocial";
export const only = part("Only", () => box(1, 1, 1));`,
    },
  });
  // `export const name` is the studio's display name (not a part); without one, the file stem
  expect(e.partInfos().map((p) => [p.id, p.file, p.name, p.studio])).toEqual([
    ["case", "studios/case.ts", "Base", "Case"],
    ["case:lid", "studios/case.ts", "Lid", "Case"],
    ["case:clip", "studios/case.ts", "Clip", "Case"],
    ["lone:only", "studios/lone.ts", "Only", "lone"],
    ["stack:shim", "studios/stack.ts", "Shim", "stack"],
  ]);
  for (const id of e.parts()) expect(e.regenerate(id).ok).toBe(true);
  const lid = e.regenerate("case:lid");
  expect(lid.name).toBe("Lid");
  expect(lid.bbox!.max[2] - lid.bbox!.min[2]).toBeCloseTo(2);
  expect(e.names("case:lid").face[0]).toStartWith("case:lid/");
  // exported together: one STEP/STL compound, one 3MF object per part
  for (const f of ["step", "stl"] as const) expect(e.exportParts(["case", "case:lid", "case:clip"], f).byteLength).toBeGreaterThan(e.exportPart("case:clip", f).byteLength);
  const model = strFromU8(unzipSync(e.exportParts(["case", "case:lid"], "3mf"))["3D/3dmodel.model"]);
  expect(model.match(/<object /g)?.length).toBe(2);

  // a studio that fails to load keeps its parts (and its name), each showing the error over its last good geometry
  e.setScript("studios/case.ts", "export const = ;");
  expect(e.parts().filter((p) => p.startsWith("case"))).toEqual(["case", "case:lid", "case:clip"]);
  expect(e.partInfos().find((p) => p.id === "case")?.studio).toBe("Case");
  const broken = e.regenerate("case:lid");
  expect(broken.ok).toBe(false);
  expect(broken.problems[0].kind).toBe("syntax");
  expect(broken.mesh).toBeDefined();

  // a studio with no parts gets one placeholder carrying an actionable error
  e.setScript("studios/case.ts", `export const n = 1;`);
  expect(e.parts().filter((p) => p.startsWith("case"))).toEqual(["case"]);
  expect(e.regenerate("case").problems[0].message).toContain("must export a part");
});

test("shared params: one override reaches every part that declares it", () => {
  const e = new Engine();
  const src = `import { part, param, box } from "parasocial";
const link = () => param("link", 40, { shared: true });
export default part("A", () => box(link(), 5, 5));
export const b = part("B", () => box(link(), 5, 5).translate([0, 10, 0]));
export const c = part("C", () => box(param("link", 40), 5, 5).translate([0, 20, 0]));
`;
  e.setDocument({ scripts: { "studios/l.ts": src }, overrides: { "*": { link: 60 } } });
  const size = (p: string) => { const r = e.regenerate(p); return r.bbox!.max[0] - r.bbox!.min[0]; };
  expect(size("l")).toBeCloseTo(60, 6);
  expect(size("l:b")).toBeCloseTo(60, 6);
  // a param of the same name that isn't shared keeps its own value
  expect(size("l:c")).toBeCloseTo(40, 6);
  expect(e.regenerate("l").params[0].shared).toBe(true);
  expect(e.regenerate("l").params[0].overridden).toBe(true);
});

test("known geometry: an edit elsewhere skips meshing, a real change doesn't", () => {
  const e = new Engine();
  const scripts = { ...docFrom("bracket"), "studios/other.ts": `import { part, box } from "parasocial"; export default part("Other", () => box(10, 10, 10));` };
  e.setDocument({ scripts });
  const first = e.regenerate("bracket");
  expect(first.unchanged).toBeUndefined();
  // another studio changes: bracket's geometry is the same, so no mesh comes back
  e.setScript("studios/other.ts", scripts["studios/other.ts"].replace("10, 10, 10", "20, 10, 10"));
  const same = e.regenerate("bracket", "fine", first.key);
  expect(same.unchanged).toBe(true);
  expect(same.key).toBe(first.key);
  expect(same.mesh).toBeUndefined();
  expect(same.params.length).toBe(first.params.length);
  // a different geometry comes back in full even when a key is given
  e.setOverrides("bracket", { [first.params[0].name]: Number(first.params[0].value) + 5 });
  const changed = e.regenerate("bracket", "fine", first.key);
  expect(changed.unchanged).toBeUndefined();
  expect(changed.key).not.toBe(first.key);
  expect(changed.mesh!.indices.length).toBeGreaterThan(0);
});

test("affected: only parts that read (or looked for) a changed script", () => {
  const e = new Engine();
  e.setDocument({
    scripts: {
      "lib/b.ts": `export const h = 4;`,
      "lib/a.ts": `import { h } from "./b"; export const size = () => h * 2;`,
      "studios/uses.ts": `import { part, box } from "parasocial"; import { size } from "../lib/a"; export default part("Uses", () => box(size(), 10, 10));`,
      "studios/lazy.ts": `import { part, box } from "parasocial"; export default part("Lazy", () => box(require("../lib/lazy").w, 5, 5));`,
      "studios/lone.ts": `import { part, box } from "parasocial"; export default part("Lone", () => box(3, 3, 3));`,
      "studios/broken.ts": `import { part, box } from "parasocial"; import { g } from "../lib/missing"; export default part("Broken", () => box(g, 1, 1));`,
      "studios/syntax.ts": `import { part, box } from "parasocial"; import { s } from "../lib/bad"; export default part("Syntax", () => box(s, 1, 1));`,
      "lib/bad.ts": `export const s = ;`,
      "lib/lazy.ts": `export const w = 7;`,
    },
  });
  // never regenerated: everything is affected
  expect(e.affected(["lib/b.ts"]).sort()).toEqual(e.parts().sort());
  for (const p of e.parts()) e.regenerate(p);
  expect(e.affected(["studios/lone.ts"])).toEqual(["lone"]);
  expect(e.affected(["lib/b.ts"])).toEqual(["uses"]); // two imports deep
  expect(e.affected(["lib/lazy.ts"])).toEqual(["lazy"]); // required while the part builds
  expect(e.affected(["lib/bad.ts"])).toEqual(["syntax"]); // failed to parse, still read
  expect(e.affected(["lib/missing.ts"])).toEqual(["broken"]); // creating it can fix the import
  expect(e.affected(["studios/other.ts"])).toEqual([]);
});

test("check: hardware seated in its own std holes isn't interference; a real overlap still is", () => {
  const e = new Engine();
  e.setDocument({
    scripts: {
      "studios/frame.ts": `import { part, box, std, type Vec3 } from "parasocial";
const side: Vec3[] = [[20, 0, 5], [20, 0, 15]];
const top: Vec3[] = [[-10, 0, 20], [0, 0, 20]];
const X: Vec3 = [-1, 0, 0];
export default part("Frame", () => box(40, 20, 20, { center: "xy" }).hole(side, { insert: "M3x5.7", direction: X }).hole(top, { insert: "M4x8.1" }).hole([10, 0, 20], { screw: "M3", fit: "tap" }));
export const inserts = part("Inserts", () => std.insert("M3x5.7", { at: side[0], direction: X }).union(std.insert("M3x5.7", { at: side[1], direction: X }), ...top.map((at) => std.insert("M4x8.1", { at }))));
export const screws = part("Screws", () => std.screw("M3", 6, { at: side[0], direction: X }).union(std.screw("M3", 6, { at: side[1], direction: X })));
export const wrong = part("Wrong", () => std.insert("M3x5.7", { at: [10, 0, 20] }));`,
    },
  });
  for (const p of e.parts()) expect(e.regenerate(p).problems).toEqual([]);
  expect(e.interference("frame", "frame:inserts")).toBe(0);
  expect(e.interference("frame", "frame:screws")).toBe(0);
  expect(e.interference("frame:inserts", "frame:screws")).toBe(0);
  // an insert in a tap-drill hole is a collision
  expect(e.interference("frame", "frame:wrong")).toBeGreaterThan(1);
  expect(e.interferences(e.parts()).map((h) => [h.a, h.b])).toEqual([["frame", "frame:wrong"]]);
});

test("a duplicate tag names both uses with their whole call chains, not just the helper line", () => {
  const e = new Engine();
  e.setDocument({
    scripts: {
      "lib/join.ts": `import { box, type Solid } from "parasocial";
export function join(s: Solid, tag: string, x: number) {
  return s.union(box(4, 4, 4).translate([x, 0, 0]), { tag });
}`,
      "studios/twice.ts": `import { part, box } from "parasocial";
import { join } from "../lib/join";
function bosses(s: ReturnType<typeof box>) {
  s = join(s, "boss0", 10);
  s = join(s, "boss0", 20);
  return s;
}
export const calls = part("Calls", () => bosses(box(40, 10, 10)));
export const loop = part("Loop", () => {
  let s = box(40, 10, 10);
  for (let i = 0; i < 2; i++) s = join(s, "boss", i * 10);
  return s;
});`,
    },
  });
  const calls = e.regenerate("twice:calls").problems[0];
  expect(calls.message).toStartWith('tag "boss0" is used twice in twice:calls: first at twice.ts:8 via bosses() at twice.ts:4 via join() at join.ts:3; again at twice.ts:8 via bosses() at twice.ts:5 via join() at join.ts:3.');
  expect(calls.source).toMatchObject({ file: "studios/twice.ts", line: 5 }); // the second call, not the helper
  const loop = e.regenerate("twice:loop").problems[0];
  expect(loop.message).toContain("first at twice.ts:11 via join() at join.ts:3; again at twice.ts:11 via join() at join.ts:3. The same call ran twice");
  expect(loop.source).toMatchObject({ file: "studios/twice.ts", line: 11 });
});

test("a param declared again with the same spec reads the same value; a different spec says what differs", () => {
  const e = new Engine();
  e.setDocument({
    scripts: {
      "lib/winch.ts": `import { param, box } from "parasocial";
export function drum() {
  const d = param("drumD", 20, { label: "Drum diameter", min: 5, shared: true });
  return box(d, 5, 5);
}`,
      "studios/w.ts": `import { part, param } from "parasocial";
import { drum } from "../lib/winch";
export const ok = part("Ok", () => drum().union(drum().translate([0, 10, 0])));
export const bad = part("Bad", () => {
  param("drumD", 25, { label: "Drum diameter", min: 5, shared: true });
  return drum();
});`,
    },
    overrides: { "*": { drumD: 30 } },
  });
  const ok = e.regenerate("w:ok");
  expect(ok.problems).toEqual([]);
  expect(ok.params.map((p) => [p.name, p.value])).toEqual([["drumD", 30]]);
  expect(ok.bbox!.max[0] - ok.bbox!.min[0]).toBeCloseTo(30, 3);
  const bad = e.regenerate("w:bad").problems[0];
  expect(bad.message).toStartWith('param "drumD" is declared twice in w:bad with a different default (first at w.ts:5).');
});
