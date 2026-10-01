// Run with the pool server up (needs deno): bun packages/engine-pool/test/robustness.e2e.ts
// A NaN script, a runaway part next to a good one, a STEP export (OCCT prints to stdout) and recovery,
// all against the real Deno host.
import { PoolClient } from "../src/client";

const c = new PoolClient(process.env.ENGINE_POOL_URL ?? "http://127.0.0.1:5190");
const head = `import { part, box, sketch, plane } from "parasocial";\n`;
const scripts = {
  "lib/dims.ts": `export const dims = { width: 40 };\n`,
  "studios/fairlead.ts": `${head}import { dims } from "../lib/dims";\nexport default part("Fairlead", () => box(dims.width, 20, 10).translate([0, dims.offset, 0]));\n`,
  "studios/cleat.ts": `${head}export default part("Cleat", () => box(10, 10, 5));\n`,
  "studios/spin.ts": `${head}export default part("Spin", () => { while (true) {} });\n`,
};
const doc = `robustness-${Date.now()}`;
const show = (label: string, r: any) => console.log(label, JSON.stringify(r).slice(0, 300));

let t = performance.now();
let r = await c.run({ document: doc, scripts, ops: [{ op: "regenerate", part: "fairlead" }, { op: "regenerate", part: "cleat" }] });
show("nan + good", r.map((x: any) => (x.ok ? { ok: x.value.ok, problems: x.value.problems.map((p: any) => p.message) } : x)));
r = await c.run({ document: doc, scripts, ops: [{ op: "regenerate", part: "spin" }, { op: "regenerate", part: "cleat" }] });
show(`runaway + good (${(performance.now() - t).toFixed(0)} ms)`, r.map((x: any) => (x.ok ? { ok: x.value.ok } : x)));
r = await c.run({ document: doc, scripts, ops: [{ op: "export", part: "cleat", format: "step" }, { op: "regenerate", part: "cleat" }] });
show("step export + regen", r.map((x: any) => (x.ok ? { ok: true, bytes: x.value.bytes ?? x.value.ok } : x)));
r = await c.run({ document: doc, scripts: { ...scripts, "lib/dims.ts": `export const dims = { width: 40, offset: 5 };\n` }, ops: [{ op: "regenerate", part: "fairlead" }] });
show("fixed", r.map((x: any) => (x.ok ? { ok: x.value.ok, bbox: x.value.bbox } : x)));
