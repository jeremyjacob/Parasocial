// Engine worker: loads OCCT, runs the Engine, answers requests from the engine page.
// Meshes are transferred, never copied (§9).
import { loadKernel, meshTransferables, kernelFault, noteKernelFault } from "@parasocial/kernel";
import { Engine, type PartResult, type Interference, type PartPose } from "../engine";
import { LatestWins } from "../scheduler";
import { drawPart } from "../drawing";
import { computeBom } from "../bom-engine";
import type { EngineRequest, EngineInfo } from "../protocol";
import { setOpObserver } from "@parasocial/api/internal";

export type WorkerInit = { type: "init"; glueSingle: string; glueMulti: string; wasmSingle: string; wasmMulti: string; threads: boolean; build: string; /** compiled once by the engine page for all its workers */ wasmModule?: WebAssembly.Module };

// The host's watchdog names the operation that was running when a request times out: tell it as
// each geometry operation starts and ends (cache hits don't run, so they don't count).
setOpObserver((phase, op) => (self as any).postMessage({ type: "op", phase, op: { part: op.part, type: op.type, tag: op.tag, source: op.source, ms: op.ms } }));

const engine = new Engine();
// snapshots (other versions) regenerate in their own engine so the live document's cache stays warm
const snapshot = { engine: new Engine(), key: "" };
const stats = { results: 0, transferred: 0 };
let ready: Promise<EngineInfo> | null = null;
/**
 * Set once the kernel has faulted (a WebAssembly trap or abort): its memory can't be trusted. The
 * worker tells its host ("poisoned") right after answering the request that hit it, and answers
 * nothing more; the host replaces it and sends the requests still waiting to the replacement.
 */
let poisoned = false;
/** Requests that run user script code: the host's watchdog covers them from "started". */
const RUNS_SCRIPTS = new Set(["setDocument", "setScript", "parts", "snapshotParts", "affected", "assemblies", "evaluate"]);

async function boot(cfg: WorkerInit): Promise<EngineInfo> {
  const t0 = performance.now();
  const useThreads = cfg.threads && (self as any).crossOriginIsolated === true && typeof SharedArrayBuffer !== "undefined";
  const glue = useThreads ? cfg.glueMulti : cfg.glueSingle;
  const wasmUrl = useThreads ? cfg.wasmMulti : cfg.wasmSingle;
  // compileStreaming lets the browser cache compiled code for the content-hashed URL
  const [mod, wasmModule] = await Promise.all([import(/* @vite-ignore */ glue), cfg.wasmModule ?? WebAssembly.compileStreaming(fetch(wasmUrl))]);
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

const regen = new LatestWins<{ id: number; part: string; quality: "coarse" | "fine"; known?: string }, PartResult>(({ id, part, quality, known }) => {
  // Arm the host's watchdog only when computation starts, not while waiting in a queue.
  if (poisoned) throw new Error("the engine is restarting");
  (self as any).postMessage({ type: "started", id });
  return engine.regenerate(part, quality, known);
});
// interference follows drags: only the newest layout is worth computing
const overlaps = new LatestWins<{ parts: string[]; ignore?: [string, string][]; poses?: Record<string, PartPose> }, Interference[]>((r) => {
  if (r.poses) engine.setPoses(r.poses);
  return engine.interferences(r.parts, r.ignore);
});

async function handle(req: EngineRequest, id: number): Promise<{ value: unknown; transfer?: Transferable[] }> {
  // (not for replays, id -1: nobody waits on them)
  if (RUNS_SCRIPTS.has(req.op) && id !== -1) (self as any).postMessage({ type: "started", id });
  switch (req.op) {
    case "ping":
      return { value: { pong: true, ...stats } };
    case "setDocument":
      engine.setDocument(req.doc);
      // a replay into a replacement worker only restores state: scripts run on the next real request
      return { value: req.quiet ? true : engine.partInfos() };
    case "setScript":
      engine.setScript(req.path, req.content);
      return { value: req.quiet ? true : engine.partInfos() };
    case "parts":
      return { value: engine.partInfos() };
    case "snapshotParts":
      if (snapshot.key !== req.key) {
        snapshot.engine.setDocument(req.doc);
        snapshot.key = req.key;
      }
      return { value: snapshot.engine.partInfos() };
    case "setOverrides":
      engine.setOverrides(req.part, req.overrides);
      return { value: true };
    case "regenerate": {
      const r = await regen.request(req.part, { id, part: req.part, quality: req.quality ?? "fine", known: req.known });
      if (!r) return { value: null }; // superseded by a newer request
      return { value: r, transfer: r.mesh ? meshTransferables(r.mesh) : [] };
    }
    case "affected":
      return { value: engine.affected(req.paths) };
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
    case "tangentChain":
      return { value: engine.tangentChain(req.part, req.edge) };
    case "loopOf":
      return { value: engine.loopOf(req.part, req.edge, req.face) };
    case "opsAtLine":
      return { value: engine.opsAtLine(req.part, req.file, req.line) };
    case "evaluate":
      return { value: engine.evaluate(req.script, req.expr, req.part) };
    case "describeAll":
      return { value: engine.describeAll(req.part) };
    case "interference":
      return { value: engine.interference(req.a, req.b) };
    case "interferencePairs":
      return { value: req.pairs.map(([a, b]) => engine.interference(a, b)) };
    case "overlapPairs":
      return { value: engine.overlaps(req.pairs, req.budgetMs) };
    case "distancePairs":
      return { value: engine.distances(req.pairs, req.within, req.budgetMs) };
    case "export": {
      const bytes = engine.exportParts(req.parts ?? (req.part ? [req.part] : []), req.format);
      // base64 so it survives JSON (pool) and structured clone alike
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { value: { base64: btoa(bin), bytes: bytes.length } };
    }
    case "drawing": {
      const { pdf, ...rest } = drawPart(engine, req.part, req.options);
      if (!pdf) return { value: rest };
      let bin = "";
      for (let i = 0; i < pdf.length; i += 0x8000) bin += String.fromCharCode(...pdf.subarray(i, i + 0x8000));
      return { value: { ...rest, base64: btoa(bin) } };
    }
    case "bom":
      return { value: computeBom(engine, { assembly: req.assembly, documentName: req.documentName }) };
    case "assemblies":
      return { value: engine.assemblies() };
    case "setPoses":
      engine.setPoses(req.poses);
      return { value: true };
    case "interferences": {
      const r = await overlaps.request("all", { parts: req.parts, ignore: req.ignore, poses: req.poses });
      if (!r) return { value: null };
      return { value: r, transfer: r.flatMap((x) => (x.mesh ? meshTransferables(x.mesh) : [])) };
    }
    case "shapeOf":
      return { value: engine.shapeOf(req.part) };
    case "adopt":
      engine.adopt(req.part, req.key, req.brep);
      return { value: true };
    case "closestPoint":
      return { value: engine.closestPoint(req.part, req.kind, req.index, req.point) };
    default:
      throw new Error(`unknown engine op "${(req as any).op}"`);
    case "regenerateSnapshot": {
      (self as any).postMessage({ type: "started", id });
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
  if (typeof m?.id !== "number" || poisoned) return;
  try {
    await ready;
    const { value, transfer } = await handle(m.req as EngineRequest, m.id);
    if (poisoned) return;
    (self as any).postMessage({ type: "result", id: m.id, ok: true, value }, transfer ?? []);
    if (transfer?.length) {
      stats.results++;
      // transferred, not copied: the worker's buffers are detached now
      if ((transfer as ArrayBuffer[]).every((b) => b.byteLength === 0)) stats.transferred++;
    }
  } catch (e) {
    if (poisoned) return;
    const fault = noteKernelFault(e);
    const error = String((e as Error)?.message ?? e);
    (self as any).postMessage({ type: "result", id: m.id, ok: false, error: fault ? `the geometry kernel crashed (${error}); the engine restarts` : error });
  }
  const fault = kernelFault();
  if (fault && !poisoned) {
    poisoned = true;
    (self as any).postMessage({ type: "poisoned", error: fault });
  }
};
