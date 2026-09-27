import { beforeAll, expect, test } from "bun:test";
import { loadKernel } from "@parasocial/kernel";
import { Engine, LatestWins } from "../src";
import { Glob } from "bun";
import { join } from "node:path";
import { readFileSync } from "node:fs";

beforeAll(async () => { await loadKernel(); });

function docFrom(dir: string) {
  const root = join(import.meta.dir, "../../../examples", dir);
  const scripts: Record<string, string> = {};
  for (const f of new Glob("{parts,lib}/**/*.ts").scanSync(root)) scripts[f] = readFileSync(join(root, f), "utf8");
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
  expect(d.createdBy?.chain?.map((c) => c.file)).toEqual(["parts/flange.ts", "lib/holes.ts"]);
});

test("syntax and runtime errors carry file:line; last good geometry stays", () => {
  const e = new Engine();
  const scripts = docFrom("bracket");
  e.setDocument({ scripts });
  expect(e.regenerate("bracket").ok).toBe(true);
  e.setScript("parts/bracket.ts", scripts["parts/bracket.ts"].replace("const w =", "const w = ="));
  const r = e.regenerate("bracket");
  expect(r.ok).toBe(false);
  expect(r.problems[0].kind).toBe("syntax");
  expect(r.problems[0].source?.line).toBe(5);
  expect(r.partial).toBe(true);
  expect(r.mesh).toBeDefined(); // last good geometry
  e.setScript("parts/bracket.ts", scripts["parts/bracket.ts"].replace(".chamfer(", ".nope("));
  const r2 = e.regenerate("bracket");
  expect(r2.problems[0].kind).toBe("runtime");
  expect(r2.problems[0].message).toContain("bracket.ts:14");
  // op failure: huge fillet -> actionable message + highlighted edges + partial result
  e.setScript("parts/bracket.ts", scripts["parts/bracket.ts"].replace(', 2, { tag: "corners" }', ', 30, { tag: "corners" }'));
  const r3 = e.regenerate("bracket");
  expect(r3.problems[0].kind).toBe("operation");
  expect(r3.problems[0].message).toMatch(/fillet radius 30 exceeds adjacent face width \d+.*\(bracket\.ts:13\)/);
  expect(r3.problems[0].highlight?.names.length).toBe(4);
  expect(r3.partial).toBe(true);
  expect(r3.mesh).toBeDefined();
});

test("sandbox hygiene: shadowed globals, seeded random, no foreign imports", async () => {
  const e = new Engine();
  e.setDocument({
    scripts: {
      "parts/a.ts": `import { part, box } from "parasocial";
export default part("A", () => {
  if (typeof fetch !== "undefined" || typeof globalThis !== "undefined" || typeof self !== "undefined") throw new Error("leak");
  const w = 10 + Math.floor(Math.random() * 10);
  if (Date.now() !== ${Date.UTC(2024, 0, 1)}) throw new Error("date");
  return box(w, 5, 5);
});`,
      "parts/b.ts": `import x from "lodash"; export default x;`,
      "parts/c.ts": `import { part, box, Solid } from "parasocial";
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
  const k1 = await derivedKey({ part: "bracket", scripts: { "parts/a.ts": "x" }, overrides: { w: 1 }, build: "b" });
  const k2 = await derivedKey({ part: "bracket", scripts: { "parts/a.ts": "x" }, overrides: { w: 2 }, build: "b" });
  expect(k1).not.toBe(k2);
});

test("describeAll, interference, exports", () => {
  const e = new Engine();
  e.setDocument({ scripts: docFrom("enclosure") });
  e.regenerate("body");
  e.regenerate("lid");
  const d = e.describeAll("body");
  expect(d.faces.length).toBeGreaterThan(10);
  expect(d.faces[0].createdBy?.source?.file).toBe("parts/body.ts");
  expect(e.interference("body", "lid")).toBeGreaterThanOrEqual(0);
  for (const f of ["step", "stl", "3mf"] as const) expect(e.exportPart("body", f).byteLength).toBeGreaterThan(100);
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
