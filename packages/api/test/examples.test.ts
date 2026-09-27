import { beforeAll, expect, test } from "bun:test";
import { loadKernel, isValid } from "@parasocial/kernel";
import { OpCache, names } from "@parasocial/naming";
import { PartContext, runPart, type PartDef } from "@parasocial/api/internal";
import { Glob } from "bun";
import { join, basename } from "node:path";

beforeAll(async () => { await loadKernel(); });

const root = join(import.meta.dir, "../../../examples");
const files = [...new Glob("*/studios/*.ts").scanSync(root)].sort();

for (const f of files) {
  test(`example ${f}`, async () => {
    // every part the script exports: the default is <stem>, named exports <stem>:<name>
    const mod = await import(join(root, f));
    const defs = Object.entries(mod).filter((e): e is [string, PartDef] => (e[1] as PartDef)?.__part === true);
    // a studio exports parts, assemblies, or both
    const assemblies = Object.values(mod).filter((v) => (v as any)?.__assembly === true);
    expect(defs.length + assemblies.length).toBeGreaterThan(0);
    for (const [key, def] of defs) {
      const id = key === "default" ? basename(f, ".ts") : `${basename(f, ".ts")}:${key}`;
      const cache = new OpCache();
      cache.begin();
      const t0 = performance.now();
      const r = runPart(def, new PartContext({ part: id, file: f.split("/").slice(1).join("/"), cache, isUserFile: (p) => p.includes("/examples/") }));
      const ms = performance.now() - t0;
      if (r.problems.length) console.log(id, r.problems);
      expect(r.problems.filter((p) => p.severity === "error")).toEqual([]);
      expect(isValid(r.record!.shape)).toBe(true);
      console.log(`${f} ${id}: ${names(r.record!, "face").length} faces, ${ms.toFixed(0)} ms`);
    }
  });
}
