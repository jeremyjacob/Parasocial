// Cold regeneration benchmark: every part of a document directory (studios/, lib/), fresh engine.
//   bun packages/runtime/bench/regen.ts <dir>
import { loadKernel } from "@parasocial/kernel";
import { Engine } from "../src";
import { Glob } from "bun";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const dir = process.argv[2];
const scripts: Record<string, string> = {};
for (const f of new Glob("{studios,lib}/**/*.ts").scanSync(dir)) scripts[f] = readFileSync(join(dir, f), "utf8");
await loadKernel();
const e = new Engine();
e.setDocument({ scripts });
const t0 = performance.now();
for (const p of e.parts()) {
  const r = e.regenerate(p);
  const t = r.timings;
  console.log(`${p.padEnd(24)} total ${t.total.toFixed(0).padStart(5)}  ops ${t.ops.toFixed(0).padStart(5)}  mesh ${t.mesh.toFixed(0).padStart(4)}  ${r.ok ? "" : "FAILED"}`);
}
console.log(`all ${(performance.now() - t0).toFixed(0)} ms`);
