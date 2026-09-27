// Build the engine origin's static assets: page + worker bundles, content-hashed OCCT glue/WASM.
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const occtDist = dirname(fileURLToPath(import.meta.resolve("replicad-opencascadejs/wasm")));

export type EngineAssets = {
  dir: string;
  build: string;
  glueSingle: string;
  glueMulti: string;
  wasmSingle: string;
  wasmMulti: string;
  wasmBytes: number;
};

const short = (buf: Uint8Array) => new Bun.CryptoHasher("sha256").update(buf).digest("hex").slice(0, 16);

export async function buildEngine(outDir = join(here, "../../dist/engine"), opts: { minify?: boolean } = {}): Promise<EngineAssets> {
  if (existsSync(outDir)) rmSync(outDir, { recursive: true });
  mkdirSync(join(outDir, "occt"), { recursive: true });
  const res = await Bun.build({
    entrypoints: [join(here, "../browser/page.ts"), join(here, "../browser/worker.ts")],
    outdir: outDir,
    target: "browser",
    format: "esm",
    splitting: false,
    minify: opts.minify ?? true,
    sourcemap: "none",
    naming: "[name].[ext]",
    external: ["replicad-opencascadejs"],
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!res.success) throw new AggregateError(res.logs, "engine build failed");
  const assets: Record<string, string> = {};
  let wasmBytes = 0;
  for (const v of ["single", "multi"]) {
    const js = readFileSync(join(occtDist, `replicad_${v}.js`));
    const wasm = readFileSync(join(occtDist, `replicad_${v}.wasm`));
    const h = short(wasm);
    const jsName = `occt/${h}.${v}.js`;
    const wasmName = `occt/${h}.${v}.wasm`;
    writeFileSync(join(outDir, jsName), js);
    copyFileSync(join(occtDist, `replicad_${v}.wasm`), join(outDir, wasmName));
    // precompressed for transfer (~5.7 MB brotli vs 23 MB raw)
    const { brotliCompressSync, constants } = await import("node:zlib");
    writeFileSync(join(outDir, wasmName + ".br"), brotliCompressSync(wasm, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }));
    assets[v] = jsName;
    assets[v + "Wasm"] = wasmName;
    if (v === "single") wasmBytes = wasm.byteLength;
  }
  const build = short(new Uint8Array([...readFileSync(join(outDir, "worker.js")), ...readFileSync(join(outDir, "page.js"))]));
  writeFileSync(
    join(outDir, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><title>Parasocial engine</title><script src="/config.js"></script><script type="module" src="/page.js?v=${build}"></script></head><body></body></html>`,
  );
  return { dir: outDir, build, glueSingle: "/" + assets.single, glueMulti: "/" + assets.multi, wasmSingle: "/" + assets.singleWasm, wasmMulti: "/" + assets.multiWasm, wasmBytes };
}
