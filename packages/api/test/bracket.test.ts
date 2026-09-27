import { beforeAll, expect, test } from "bun:test";
import { loadKernel } from "@parasocial/kernel";
import { OpCache, names, select } from "@parasocial/naming";
import { PartContext, runPart } from "@parasocial/api/internal";
import bracket from "../../../examples/bracket/studios/bracket";

beforeAll(async () => { await loadKernel(); });

const run = (cache: OpCache, overrides: Record<string, string | number> = {}) => {
  cache.begin();
  return runPart(bracket, new PartContext({ part: "bracket", file: "studios/bracket.ts", cache, overrides, isUserFile: (f) => f.includes("examples/") }));
};

test("bracket regenerates with stable names", () => {
  const cache = new OpCache();
  const r = run(cache);
  expect(r.problems).toEqual([]);
  expect(r.ok).toBe(true);
  const faces = names(r.record!, "face").map((n) => n.str);
  console.log(faces.join("\n"));
  expect(faces).toContain("bracket/base · side · outline/right");
  expect(faces).toContain("bracket/base · cap.end");
  expect(faces.filter((f) => f.startsWith("bracket/corners · fillet")).length).toBe(4);
  expect(faces.some((f) => f.startsWith("bracket/chamfer1 · chamfer"))).toBe(true);
  expect(r.params.map((p) => p.name)).toEqual(["thickness", "width"]);
  const ops = r.ops.map((o) => `${o.id} @${o.callSite?.line}`);
  console.log(ops);
  expect(r.ops.find((o) => o.id === "bracket/corners")!.callSite!.line).toBe(15);
});

test("names survive upstream dimension changes; per-op cache reruns only downstream", () => {
  const cache = new OpCache();
  const a = run(cache);
  const before = names(a.record!, "face").map((n) => n.str).sort();
  const b = run(cache, { width: 60 });
  const after = names(b.record!, "face").map((n) => n.str).sort();
  expect(after).toEqual(before);
  // same params again: everything cached
  const c = run(cache, { width: 60 });
  expect(c.timings.cacheMisses).toBe(0);
  expect(c.timings.cacheHits).toBeGreaterThan(0);
  // thickness change: sketch stays cached
  const d = run(cache, { width: 60, thickness: 4 });
  expect(d.timings.cacheHits).toBeGreaterThanOrEqual(1);
  expect(select(d.record!, "face", "corners").length).toBe(4);
});

test("override validation", () => {
  const cache = new OpCache();
  const r = run(cache, { thickness: 50 });
  expect(r.params[0].overridden).toBe(false);
  expect(r.problems[0].kind).toBe("param");
  const r2 = run(cache, { thickness: "=width/10" });
  expect(r2.params[0].value).toBe(4);
});

test("a sketch and the solid made from it can share a tag", async () => {
  const { loadKernel } = await import("@parasocial/kernel");
  await loadKernel();
  const { OpCache } = await import("@parasocial/naming");
  const { PartContext, runPart } = await import("../src/internal");
  const { part, sketch, plane } = await import("../src");
  const def = part("Rib", () => sketch(plane.XY, { tag: "rib" }).rect(10, 4).extrude(3, { tag: "rib" }));
  const cache = new OpCache();
  cache.begin();
  const r = runPart(def, new PartContext({ part: "rib", file: "studios/rib.ts", cache }));
  expect(r.problems).toEqual([]);
  expect(r.record?.id).toBe("rib/rib");
});
