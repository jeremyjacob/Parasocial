// Engine worker: loads OCCT, runs the Engine, answers requests from the engine page.
// Meshes are transferred, never copied (§9).
import { loadKernel, meshTransferables } from "@parasocial/kernel";
import { Engine, type PartResult } from "../engine";
import { LatestWins } from "../scheduler";
import type { EngineRequest, EngineInfo } from "../protocol";

export type WorkerInit = { type: "init"; glueSingle: string; glueMulti: string; wasmSingle: string; wasmMulti: string; threads: boolean; build: string };

const engine = new Engine();
// snapshots (other versions) regenerate in their own engine so the live document's cache stays warm
const snapshot = { engine: new Engine(), key: "" };
const stats = { results: 0, transferred: 0 };
let ready: Promise<EngineInfo> | null = null;

async function boot(cfg: WorkerInit): Promise<EngineInfo> {
  const t0 = performance.now();
  const useThreads = cfg.threads && (self as any).crossOriginIsolated === true && typeof SharedArrayBuffer !== "undefined";
  const glue = useThreads ? cfg.glueMulti : cfg.glueSingle;
  const wasmUrl = useThreads ? cfg.wasmMulti : cfg.wasmSingle;
  // compileStreaming lets the browser cache compiled code for the content-hashed URL
  const [mod, wasmModule] = await Promise.all([import(/* @vite-ignore */ glue), WebAssembly.compileStreaming(fetch(wasmUrl))]);
  const oc = await loadKernel({ init: mod.default, wasmModule, mainScriptUrlOrBlob: useThreads ? glue : undefined });
  let threads = 1;
  if (useThreads) {
    try {
      (oc as any).BOPAlgo_Options.SetParallelMode(true);
    } catch {}
  }
  try {
    threads = useThreads ? (oc as any).OSD_ThreadPool.DefaultPool(-1).NbThreads() : 1;
  } catch {}
  return { threads, crossOriginIsolated: (self as any).crossOriginIsolated === true, kernelMs: performance.now() - t0, build: cfg.build };
}

const regen = new LatestWins<{ part: string; quality: "coarse" | "fine" }, PartResult>(({ part, quality }) => engine.regenerate(part, quality));

async function handle(req: EngineRequest): Promise<{ value: unknown; transfer?: Transferable[] }> {
  switch (req.op) {
    case "ping":
      return { value: { pong: true, ...stats } };
    case "setDocument":
      engine.setDocument(req.doc);
      return { value: engine.parts() };
    case "setScript":
      engine.setScript(req.path, req.content);
      return { value: engine.parts() };
    case "setOverrides":
      engine.setOverrides(req.part, req.overrides);
      return { value: true };
    case "regenerate": {
      const r = await regen.request(req.part, { part: req.part, quality: req.quality ?? "fine" });
      if (!r) return { value: null }; // superseded by a newer request
      return { value: r, transfer: r.mesh ? meshTransferables(r.mesh) : [] };
    }
    case "names":
      return { value: engine.names(req.part) };
    case "describe":
      return { value: engine.describe(req.part, req.kind, req.index) };
    case "fromOperation":
      return { value: engine.fromOperation(req.part, req.opId) };
    case "query":
      return { value: engine.query(req.part, req.expr, req.kind) };
    case "resolve":
      return { value: req.targets.map((t) => engine.resolve(req.part, t, req.tolerance)) };
    case "resolveOne":
      return { value: engine.resolveOne(req.part, req.kind, req.candidates, req.point, req.neighbors) };
    case "indexOfName":
      return { value: engine.indexOfName(req.part, req.kind, req.name) };
    case "measure":
      return { value: engine.measure(req.a, req.b) };
    case "check":
      return { value: engine.check(req.part) };
    case "opsAtLine":
      return { value: engine.opsAtLine(req.part, req.file, req.line) };
    case "describeAll":
      return { value: engine.describeAll(req.part) };
    case "interference":
      return { value: engine.interference(req.a, req.b) };
    case "export": {
      const bytes = engine.exportPart(req.part, req.format);
      // base64 so it survives JSON (pool) and structured clone alike
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { value: { base64: btoa(bin), bytes: bytes.length } };
    }
    case "closestPoint":
      return { value: engine.closestPoint(req.part, req.kind, req.index, req.point) };
    default:
      throw new Error(`unknown engine op "${(req as any).op}"`);
    case "regenerateSnapshot": {
      if (snapshot.key !== req.key) {
        snapshot.engine.setDocument(req.doc);
        snapshot.key = req.key;
      }
      const r = snapshot.engine.regenerate(req.part, "fine");
      return { value: r, transfer: r.mesh ? meshTransferables(r.mesh) : [] };
    }
  }
}

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data;
  if (m?.type === "init") {
    ready = boot(m as WorkerInit);
    try {
      const info = await ready;
      (self as any).postMessage({ type: "ready", info });
    } catch (e) {
      (self as any).postMessage({ type: "fatal", error: String((e as Error)?.message ?? e) });
    }
    return;
  }
  if (typeof m?.id !== "number") return;
  try {
    await ready;
    const { value, transfer } = await handle(m.req as EngineRequest);
    (self as any).postMessage({ type: "result", id: m.id, ok: true, value }, transfer ?? []);
    if (transfer?.length) {
      stats.results++;
      // transferred, not copied: the worker's buffers are detached now
      if ((transfer as ArrayBuffer[]).every((b) => b.byteLength === 0)) stats.transferred++;
    }
  } catch (e) {
    (self as any).postMessage({ type: "result", id: m.id, ok: false, error: String((e as Error)?.message ?? e) });
  }
};
