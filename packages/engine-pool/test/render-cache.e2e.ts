// Real Deno/WebGPU cache regression: run with ENGINE_POOL_URL pointing at a test pool.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { PoolClient } from "../src/client";

const pool = new PoolClient();
const scripts = { "studios/bracket.ts": readFileSync("examples/bracket/studios/bracket.ts", "utf8") };
const document = `render-cache-${Date.now()}`;
const run = async (ops: any[], source = scripts, overrides = {}) => {
  const results = await pool.run({ document, scripts: source, overrides, ops });
  for (const r of results) assert.equal(r.ok, true, !r.ok ? r.error : undefined);
  return results.map((r: any) => r.value);
};
const base = { op: "render", parts: ["bracket"], view: "iso", width: 640, height: 480 };
const [part, first] = await run([{ op: "regenerate", part: "bracket" }, base]);
assert.equal(part.ok, true);
const pose = { r: [0, -1, 0, 1, 0, 0, 0, 0, 1], t: [15, 5, 10] };
const [selected, cut, hidden, moved, restored] = await run([
  { ...base, highlight: [{ part: "bracket", kind: "face", index: 0 }] },
  { ...base, section: { origin: [0, 0, 1.5], normal: [0, 0, 1] } },
  { ...base, style: "hiddenLine" },
  { ...base, poses: { bracket: pose } },
  base,
]);
for (const r of [selected, cut, hidden, moved]) assert.notEqual(r.png, first.png);
assert.equal(restored.png, first.png, "render options must not poison cached geometry");
const [, , fineAgain] = await run([
  { op: "regenerate", part: "bracket", quality: "coarse" },
  { op: "regenerate", part: "bracket", quality: "fine" },
  base,
]);
assert.equal(fineAgain.png, first.png, "cached fine regeneration must restore the fine render mesh");
const [, wider] = await run([{ op: "regenerate", part: "bracket" }, base], scripts, { bracket: { width: 70 } });
assert.notEqual(wider.png, first.png, "param previews must invalidate both metadata and rendering");
const [, back] = await run([{ op: "regenerate", part: "bracket" }, base]);
assert.equal(back.png, first.png, "clearing a preview must restore the original geometry");
const edited = { "studios/bracket.ts": scripts["studios/bracket.ts"].replace('param("width", 40', 'param("width", 65') };
const [, changed] = await run([{ op: "regenerate", part: "bracket" }, base], edited);
assert.notEqual(changed.png, first.png, "script writes must invalidate cached images");
console.log("render caches: selection, section, style, pose, quality, param and script changes passed");
