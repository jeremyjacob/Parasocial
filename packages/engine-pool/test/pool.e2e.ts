// Run with the pool server up: bun packages/engine-pool/test/pool.e2e.ts <outdir>
import { PoolClient } from "../src/client";
import { readFileSync, writeFileSync } from "node:fs";
const c = new PoolClient();
const scripts = { "studios/bracket.ts": readFileSync("examples/bracket/studios/bracket.ts", "utf8") };
let t = performance.now();
let r = await c.run({ document: "test-doc", scripts, ops: [{ op: "regenerate", part: "bracket" }, { op: "render", view: "iso", width: 800, height: 600 }] });
console.log("cold job ms", (performance.now() - t).toFixed(0), r[0].ok && (r[0] as any).value.ok, (r[0] as any).value?.timings?.total?.toFixed(1));
writeFileSync(`${process.argv[2]}/pool-render.png`, Buffer.from((r[1] as any).value.png, "base64"));
t = performance.now();
r = await c.run({ document: "test-doc", scripts, overrides: { bracket: { width: 70 } }, ops: [{ op: "regenerate", part: "bracket" }] });
console.log("warm param job ms", (performance.now() - t).toFixed(0), (r[0] as any).value.ok);
t = performance.now();
r = await c.run({ document: "test-doc", scripts: { "studios/bracket.ts": scripts["studios/bracket.ts"].replace("25, {", "30, {") }, ops: [{ op: "regenerate", part: "bracket" }] });
console.log("warm write job ms", (performance.now() - t).toFixed(0), (r[0] as any).value.ok);
r = await c.run({ document: "test-doc", scripts: { "studios/bracket.ts": "import { part, box } from 'parasocial'; export default part('X', () => { while (true) {} });" }, ops: [{ op: "regenerate", part: "bracket" }] });
console.log("timeout", JSON.stringify(r[0]).slice(0, 200));
r = await c.run({ document: "test-doc", scripts, ops: [{ op: "regenerate", part: "bracket" }] });
console.log("recovered", (r[0] as any).value?.ok);
