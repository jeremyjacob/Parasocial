import { beforeAll, expect, test } from "bun:test";
import { loadKernel, isValid } from "@parasocial/kernel";
import { OpCache, names } from "@parasocial/naming";
import { PartContext, runPart, type PartDef } from "@parasocial/api/internal";
import { Glob } from "bun";
import { join, basename } from "node:path";

beforeAll(async () => { await loadKernel(); });

const root = join(import.meta.dir, "../../../examples");
const files = [...new Glob("*/parts/*.ts").scanSync(root)].sort();

for (const f of files) {
  test(`example ${f}`, async () => {
    const def: PartDef = (await import(join(root, f))).default;
    const cache = new OpCache();
    cache.begin();
    const t0 = performance.now();
    const r = runPart(def, new PartContext({ part: basename(f, ".ts"), file: f.split("/").slice(1).join("/"), cache, isUserFile: (p) => p.includes("/examples/") }));
    const ms = performance.now() - t0;
    if (r.problems.length) console.log(f, r.problems);
    expect(r.problems.filter((p) => p.severity === "error")).toEqual([]);
    expect(isValid(r.record!.shape)).toBe(true);
    console.log(`${f}: ${names(r.record!, "face").length} faces, ${ms.toFixed(0)} ms`);
  });
}
