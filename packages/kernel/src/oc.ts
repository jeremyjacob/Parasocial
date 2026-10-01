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

// ---------- faults ----------
// A WebAssembly trap (out-of-bounds access, `unreachable`), an Emscripten abort or a stack overflow
// inside the kernel unwinds through C++ frames without running their cleanup: the kernel's memory
// (heap, stack pointer, OCCT's globals) can't be trusted afterwards, even though the call that hit
// it threw a catchable error. The engine notes the fault and its worker is replaced.

let fault: string | null = null;

/** Is this error a kernel fault (not an ordinary OCCT exception or script error)? */
export function isKernelFault(e: unknown): boolean {
  if (typeof WebAssembly !== "undefined" && e instanceof (WebAssembly as any).RuntimeError) return true;
  if (!(e instanceof Error)) return false;
  const m = e.message ?? "";
  if (/^Aborted\(|out of bounds memory access|memory access out of bounds|^unreachable( executed)?$|call stack exhausted/i.test(m)) return true;
  // a stack overflow while inside the kernel (wasm frames on the stack)
  return e instanceof RangeError && /Maximum call stack/i.test(m) && /wasm/i.test(e.stack ?? "");
}

/** Record `e` if it's a kernel fault; returns whether it was. */
export function noteKernelFault(e: unknown): boolean {
  if (!isKernelFault(e)) return false;
  fault ??= faultMessage(e);
  return true;
}

/** A kernel fault's message without engine-internal noise. */
export function faultMessage(e: unknown): string {
  return String((e as Error)?.message ?? e).replace(/\s*\(evaluating [^)]*\)\s*$/, "");
}

/** The first kernel fault since load (null if none): this kernel instance should be replaced. */
export function kernelFault(): string | null {
  return fault;
}

/** Tests only: forget a recorded fault. */
export function clearKernelFault() {
  fault = null;
}

/** Human-readable message for an OCCT/embind exception. */
export function occtMessage(e: unknown): string {
  noteKernelFault(e);
  if (e instanceof Error) return e.message;
  // a C++ exception: a pointer (JS exceptions build) or a WebAssembly.Exception (wasm EH build)
  const wasmException = typeof WebAssembly !== "undefined" && (WebAssembly as any).Exception && e instanceof (WebAssembly as any).Exception;
  if ((typeof e === "number" || wasmException) && instance) {
    try {
      const m = (instance as any).getExceptionMessage?.(e);
      if (Array.isArray(m)) return m.filter(Boolean).join(": ") || "OCCT exception";
      if (m) return String(m);
    } catch {}
    return wasmException ? "OCCT exception" : `OCCT exception ${e}`;
  }
  return String(e);
}
