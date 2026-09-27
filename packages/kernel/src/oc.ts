// Loading and access to the OCCT WASM module (replicad's build, see PLAN §4).
import type { OpenCascadeInstance } from "replicad-opencascadejs";

export type OC = OpenCascadeInstance & { wasmMemory: WebAssembly.Memory; [k: string]: any };

export type LoadOptions = {
  /** Emscripten glue factory (`replicad-opencascadejs` default export, or the `/multi` variant). */
  init?: (opts: Record<string, unknown>) => Promise<OpenCascadeInstance>;
  /** URL or path of the .wasm. */
  wasmUrl?: string;
  /** Precompiled module (e.g. from `WebAssembly.compileStreaming`, cached by the browser). */
  wasmModule?: WebAssembly.Module;
  /** Required by the threaded build so pthread workers can load the glue. */
  mainScriptUrlOrBlob?: string | Blob;
};

let instance: OC | null = null;
let loading: Promise<OC> | null = null;

export function loadKernel(opts: LoadOptions = {}): Promise<OC> {
  if (instance) return Promise.resolve(instance);
  if (loading) return loading;
  loading = (async () => {
    const init = opts.init ?? (await import("replicad-opencascadejs")).default;
    const emOpts: Record<string, unknown> = {};
    if (opts.wasmUrl) emOpts.locateFile = () => opts.wasmUrl;
    if (opts.mainScriptUrlOrBlob) emOpts.mainScriptUrlOrBlob = opts.mainScriptUrlOrBlob;
    if (opts.wasmModule) {
      const mod = opts.wasmModule;
      emOpts.instantiateWasm = (imports: WebAssembly.Imports, done: (i: WebAssembly.Instance, m: WebAssembly.Module) => void) => {
        WebAssembly.instantiate(mod, imports).then((i) => done(i, mod));
        return {};
      };
    }
    instance = (await init(emOpts)) as OC;
    return instance;
  })();
  return loading;
}

/** The loaded kernel. Throws if `loadKernel` hasn't resolved. */
export function oc(): OC {
  if (!instance) throw new Error("kernel not loaded: call loadKernel() first");
  return instance;
}

export function isKernelLoaded() {
  return instance !== null;
}

/** Human-readable message for an OCCT/embind exception. */
export function occtMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "number" && instance) {
    try {
      const m = (instance as any).getExceptionMessage?.(e);
      if (Array.isArray(m)) return m.filter(Boolean).join(": ");
      if (m) return String(m);
    } catch {}
    return `OCCT exception ${e}`;
  }
  return String(e);
}
