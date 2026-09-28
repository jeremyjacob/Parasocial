// Host configuration, set before the engine script runs (it reads the POOL global on load).
// The OCCT module is compiled once here and handed to every worker, replacements included.
declare const Deno: any;

const args = JSON.parse(Deno.args[0]) as { assets: { glueSingle: string; wasmSingle: string; build: string }; timeoutMs: number };
const at = (p: string) => new URL("." + p, import.meta.url).href;

(globalThis as any).POOL = {
  worker: at("/worker.js"),
  init: { glueSingle: at(args.assets.glueSingle), wasmSingle: at(args.assets.wasmSingle), glueMulti: "", wasmMulti: "", build: args.assets.build, wasmModule: await WebAssembly.compile(await Deno.readFile(new URL(at(args.assets.wasmSingle)))) },
  timeoutMs: args.timeoutMs,
};
