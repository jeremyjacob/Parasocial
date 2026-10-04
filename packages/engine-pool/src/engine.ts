// Engine worker (same build as the browser) with a watchdog and self-healing, for the Deno host.
// Written as a script over globals (POOL, Worker) so the timeout tests can run it with fakes.
//
// The worker is replaced (document state replayed, without running scripts) when:
// - a request runs past the timeout (a script looping forever): every request in flight fails;
// - the worker crashes (an uncaught error, a module that won't load): every request in flight fails;
// - the kernel faults (a WebAssembly trap or abort leaves its memory corrupt): the request that hit it
//   has its answer already; the others are sent again to the replacement;
// - it fails to start: requests waiting for it fail, and the next attempt follows after a backoff.
// Replacements back off (0, 250 ms, 500 ms… up to 30 s) while crashes repeat within a minute, so a
// document whose script crashes the engine on every load can't spin the host.
declare const POOL: { worker: string; init: Record<string, unknown>; timeoutMs: number };
const cfg = (globalThis as any).POOL as typeof POOL;

/** Requests that run user script code: the watchdog covers them once the worker says "started". */
const WATCHED = new Set(["regenerate", "regenerateSnapshot", "setDocument", "setScript", "parts", "snapshotParts", "affected", "assemblies", "evaluate"]);
const CRASH_WINDOW_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;

type Pending = { req: any; timer: ReturnType<typeof setTimeout> | null; resolve: (v: any) => void; reject: (e: Error) => void };

let worker: Worker | null = null;
let ready!: Promise<any>;
let nextId = 1;
const pending = new Map<number, Pending>();
let docState: any[] = [];
const crashes: number[] = [];
const meshes = new Map<string, any>(); // last regeneration result per part (with mesh), for renders
// The pool serializes a document's jobs. With the same scripts, units and overrides, a
// regeneration is deterministic: reuse its metadata and the mesh already held by this host.
const regenerations = new Map<string, any>();
let revision = 0;

/** What the worker is computing (from its "op" messages), for timeout messages. */
type OpInfo = { part: string; type: string; tag?: string; source?: { file: string; line: number }; ms?: number };
let progress = { current: null as null | { op: OpInfo; at: number }, slowest: null as OpInfo | null, opsMs: 0, count: 0 };
function track(phase: "start" | "end", op: OpInfo) {
  if (phase === "start") return void (progress.current = { op, at: Date.now() });
  progress.current = null;
  progress.count++;
  progress.opsMs += op.ms ?? 0;
  if (!progress.slowest || (op.ms ?? 0) > (progress.slowest.ms ?? 0)) progress.slowest = op;
}

/**
 * Why a request ran out of time: the geometry operation that was running (with its source line),
 * or, when none was, that script code may loop forever.
 */
function timeoutMessage(req: any, limitMs: number): string {
  const what = req.op === "regenerate" || req.op === "regenerateSnapshot" ? `regeneration${req.part ? ` of ${req.part}` : ""}` : req.op === "evaluate" ? "evaluation" : "loading the scripts";
  const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const name = (op: OpInfo) => `${op.type}${op.tag ? ` "${op.tag}"` : ""}${op.source ? ` at ${op.source.file}:${op.source.line}` : ""}`;
  const head = `${what} timed out after ${limitMs / 1000} s (the time limit)`;
  const { current, slowest, opsMs, count } = progress;
  const done = count ? `; ${count} geometry operation${count === 1 ? "" : "s"} finished before it in ${s(opsMs)}${slowest && (slowest.ms ?? 0) >= 100 ? ` (slowest: ${name(slowest)}, ${s(slowest.ms!)})` : ""}` : "";
  if (current) return `${head} while ${name(current.op)} was running (${s(Date.now() - current.at)} so far)${done}. The geometry is too heavy, not looping: simplify that operation (fewer or smaller tools per boolean, smaller fillets) or split the work`;
  if (count && opsMs >= limitMs / 2) return `${head}: geometry operations took ${s(opsMs)} of it${done}. Reduce the number or size of operations`;
  const where = what === "loading the scripts" ? "a script may loop forever at its top level" : what === "evaluation" ? "the expression or the code it calls may loop forever" : "the script may loop forever";
  return `${head}: no geometry operation was running, so ${where}${done}`;
}
const READS = new Set(["parts", "assemblies", "measure", "interference", "interferencePairs", "distancePairs", "interferences", "check", "query", "describe", "describeAll", "resolve", "resolveOne", "indexOfName", "names", "tangentChain", "loopOf", "opsAtLine", "fromOperation", "closestPoint", "bom", "drawing", "export", "evaluate"]);
const POSED_READS = new Set(["measure", "interference", "interferencePairs", "distancePairs", "interferences", "export"]);
const readCache = new Map<string, { value: any; bytes: number }>();
let readBytes = 0, readRevision = 0, poses = "";
function clearReads() {
  readCache.clear();
  readBytes = 0;
  readRevision++;
}
function rememberRead(key: string, value: any) {
  const bytes = (key.length + JSON.stringify(value).length) * 2;
  const budget = 8 * 1024 * 1024;
  if (bytes > budget) return;
  const previous = readCache.get(key);
  if (previous) {
    readCache.delete(key);
    readBytes -= previous.bytes;
  }
  while (readCache.size && (readBytes + bytes > budget || readCache.size >= 128)) {
    const [oldKey, old] = readCache.entries().next().value!;
    readCache.delete(oldKey);
    readBytes -= old.bytes;
  }
  readCache.set(key, { value, bytes });
  readBytes += bytes;
}

function spawn() {
  const spawned = new Worker(cfg.worker, { type: "module" });
  worker = spawned;
  ready = new Promise((resolve, reject) => {
    spawned.onmessage = (ev: MessageEvent) => {
      if (spawned !== worker) return;
      const m = ev.data;
      if (m?.type === "ready") return resolve(m.info);
      if (m?.type === "fatal") {
        const e = new Error(`the geometry engine failed to start: ${m.error}`);
        reject(e);
        return restart(e, false);
      }
      if (m?.type === "started") return arm(m.id);
      if (m?.type === "op") return track(m.phase, m.op);
      if (m?.type === "poisoned") return restart(new Error(`the geometry kernel crashed (${m.error})`), true);
      if (m?.type === "result") {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        m.ok ? p.resolve(m.value) : p.reject(new Error(m.error));
      }
    };
    // An uncaught error in the worker: handled here, so it never takes the host process down with it.
    spawned.onerror = (ev: any) => {
      ev?.preventDefault?.();
      if (spawned !== worker) return;
      const e = new Error(`the geometry engine crashed: ${ev?.message || "the worker stopped"}; it restarts on the next request`);
      reject(e);
      restart(e, false);
    };
  });
  ready.catch(() => {}); // the requests waiting on it get the error
  spawned.postMessage({ type: "init", threads: false, ...cfg.init });
}

/** Document state as one quiet setDocument (or quiet steps): restores, runs no script code. */
function replay(): any[] {
  const [first, ...rest] = docState;
  if (first?.op !== "setDocument") return docState.map((r) => (r.op === "setScript" ? { ...r, quiet: true } : r));
  const scripts = { ...first.doc.scripts };
  const overrides = { ...(first.doc.overrides ?? {}) };
  for (const r of rest) {
    if (r.op === "setScript") r.content === null ? delete scripts[r.path] : (scripts[r.path] = r.content);
    else if (r.op === "setOverrides") overrides[r.part] = r.overrides;
  }
  return [{ op: "setDocument", doc: { ...first.doc, scripts, overrides }, quiet: true }];
}

/** Replace the worker. `resend`: send the requests in flight to the replacement instead of failing them. */
function restart(error: Error, resend: boolean) {
  revision++;
  regenerations.clear();
  meshes.clear();
  clearReads();
  poses = "";
  const old = worker;
  worker = null;
  old?.terminate();
  for (const p of pending.values()) {
    if (p.timer !== null) clearTimeout(p.timer);
    p.timer = null;
  }
  if (!resend) {
    const failed = [...pending.values()];
    pending.clear();
    for (const p of failed) p.reject(error);
  }
  const now = Date.now();
  crashes.push(now);
  while (crashes.length && now - crashes[0] > CRASH_WINDOW_MS) crashes.shift();
  const delay = crashes.length <= 1 ? 0 : Math.min(MAX_BACKOFF_MS, 250 * 2 ** (crashes.length - 2));
  const boot = () => {
    spawn();
    for (const r of replay()) worker!.postMessage({ id: -1, req: r });
    for (const [id, p] of pending) worker!.postMessage({ id, req: p.req });
  };
  if (delay === 0) return boot();
  // requests arriving meanwhile wait for the replacement
  ready = new Promise((resolve) => setTimeout(resolve, delay)).then(() => {
    boot();
    return ready;
  });
  ready.catch(() => {});
}

/** The worker started running a request: give it its full budget from now. */
function arm(id: number) {
  const p = pending.get(id);
  if (!p || p.timer !== null || !WATCHED.has(p.req.op)) return;
  progress = { current: null, slowest: null, opsMs: 0, count: 0 };
  p.timer = setTimeout(() => {
    // Every pending call belongs to the terminated worker, including queued calls.
    restart(Object.assign(new Error(timeoutMessage(p.req, cfg.timeoutMs)), { timeout: true }), false);
  }, cfg.timeoutMs);
}

spawn();

async function call(req: any): Promise<any> {
  // state first, so a replacement started meanwhile still gets it
  if (req.op === "setDocument") docState = [req];
  else if (req.op === "setScript" || req.op === "setOverrides") docState.push(req);
  do await ready;
  while (!worker); // replaced while we waited: wait for the replacement
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const p: Pending = {
      req,
      timer: null,
      resolve: (v) => (p.timer !== null && clearTimeout(p.timer), resolve(v)),
      reject: (e) => (p.timer !== null && clearTimeout(p.timer), reject(e)),
    };
    pending.set(id, p);
    worker!.postMessage({ id, req });
  });
}

/** One engine request. Regeneration results keep their mesh here (for renders); metadata goes back. */
(globalThis as any).rpc = async (req: any) => {
  try {
    if (req.op === "setDocument" || req.op === "setScript" || req.op === "setOverrides" || req.op === "adopt") {
      revision++;
      regenerations.clear();
      clearReads();
    }
    if (req.op === "setPoses" || (req.op === "interferences" && req.poses !== undefined)) {
      const next = JSON.stringify(req.poses ?? {});
      // Descriptions, BOMs, drawings and validity checks use source geometry. Keep
      // them warm while a mechanism moves; measurements/exports include its pose.
      if (next !== poses) readRevision++;
      poses = next;
    }
    const cacheKey = req.op === "regenerate" && req.known === undefined ? `${req.part}\0${req.quality ?? "fine"}` : undefined;
    const cached = cacheKey && regenerations.get(cacheKey);
    if (cached) {
      meshes.set(req.part, cached);
      const { mesh, ...meta } = cached;
      return { ok: true, value: { ...meta, timings: { total: 0, script: 0, ops: 0, mesh: 0, cacheHits: 0, cacheMisses: 0 } } };
    }
    if (req.op === "regenerate") clearReads();
    // Drawings default to today's date; a long-lived host must refresh the title block.
    const readKey = READS.has(req.op) ? JSON.stringify(req) + (POSED_READS.has(req.op) ? poses : "") + (req.op === "drawing" && !req.options?.date ? new Date().toISOString().slice(0, 10) : "") : undefined;
    const readHit = readKey && readCache.get(readKey);
    if (readHit) {
      // This read also changes worker state. A previous setPoses may have moved
      // the mechanism since its overlaps were cached; synchronize before reuse.
      if (req.op === "interferences" && req.poses !== undefined) await call({ op: "setPoses", poses: req.poses });
      readCache.delete(readKey!);
      readCache.set(readKey!, readHit);
      return { ok: true, value: readHit.value };
    }
    const startedRevision = revision;
    const startedReadRevision = readRevision;
    const v = await call(req);
    if (req.op === "regenerate" && v) {
      if (v.mesh) meshes.set(req.part, v);
      else meshes.delete(req.part);
      const { mesh, ...meta } = v;
      // Never retain failures (including watchdog/kernel faults), or a result computed
      // across a worker replacement or a concurrent document change.
      if (cacheKey && v.ok && mesh && startedRevision === revision) regenerations.set(cacheKey, v);
      return { ok: true, value: meta };
    }
    // overlap volumes only: their meshes are for the viewer
    if (req.op === "interferences" && Array.isArray(v)) {
      const value = v.map(({ mesh, ...x }: any) => x);
      if (readKey && startedReadRevision === readRevision) rememberRead(readKey, value);
      return { ok: true, value };
    }
    if (readKey && v !== undefined && startedReadRevision === readRevision) rememberRead(readKey, v);
    return { ok: true, value: v };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e), timeout: !!e?.timeout };
  }
};

(globalThis as any).poolMeshes = meshes;
(globalThis as any).poolReady = ready.then((info) => info);
