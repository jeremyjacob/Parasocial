// Real renders through the engine pool (deno + WebGPU): an assembly posed by a session preview,
// Z-up and Y-up named views. Start the pool first, then:
//   ENGINE_POOL_URL=http://127.0.0.1:5190 bun packages/mcp/test/render-poses.e2e.ts <outdir>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PoolClient } from "@parasocial/engine-pool/client";
import { solveAssemblies } from "../src/preview";

const root = join(import.meta.dir, "../../../examples/hinge");
const scripts = { "studios/box.ts": readFileSync(join(root, "studios/box.ts"), "utf8"), "studios/mechanism.ts": readFileSync(join(root, "studios/mechanism.ts"), "utf8") };
const out = process.argv[2] ?? ".";
const pool = new PoolClient();
const job = (ops: any[]) => pool.run({ document: "render-poses-e2e", scripts, ops });

const [asm] = await job([{ op: "assemblies" }]);
const infos = (asm as any).value;
const sources = ["box", "box:lid", "box:drawer"];
const regen = await job(sources.map((part) => ({ op: "regenerate", part })));
const meta = new Map(sources.map((p, i) => [p, (regen[i] as any).value]));
const { poses } = solveAssemblies(infos, (p) => meta.get(p), {}, { mechanism: { lid: [100], drawer: [30] } });
const ids = infos[0].instances.map((i: any) => i.id);
const shots: [string, any][] = [
  ["assembly-posed-iso", { view: "iso", parts: ids, poses }],
  ["assembly-home-iso", { view: "iso", parts: ids, poses: {} }],
  ["lid-instance-front-z", { view: "front", parts: ["mechanism/box:lid"], poses }],
  ["assembly-posed-front-y", { view: "front", up: "y", parts: ids, poses }],
  ["assembly-posed-iso-y", { view: "iso", up: "y", parts: ids, poses }],
];
const res = await job([...ids.map((part: string) => ({ op: "regenerate", part })), ...shots.map(([, o]) => ({ op: "render", width: 640, height: 480, ...o }))]);
shots.forEach(([name], i) => {
  const r = res[ids.length + i] as any;
  if (!r.ok) throw new Error(`${name}: ${r.error}`);
  writeFileSync(join(out, `${name}.png`), Buffer.from(r.value.png, "base64"));
  console.log("wrote", join(out, `${name}.png`));
});
