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
const WATCHED = new Set(["regenerate", "regenerateSnapshot", "setDocument", "setScript", "parts", "snapshotParts", "affected", "assemblies"]);
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
  p.timer = setTimeout(() => {
    const what = p.req.op === "regenerate" || p.req.op === "regenerateSnapshot" ? "regeneration" : "loading the scripts";
    const where = what === "regeneration" ? "the script may loop forever" : "a script may loop forever at its top level";
    // Every pending call belongs to the terminated worker, including queued calls.
    restart(Object.assign(new Error(`${what} timed out after ${cfg.timeoutMs / 1000} s: ${where}`), { timeout: true }), false);
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
    const v = await call(req);
    if (req.op === "regenerate" && v) {
      if (v.mesh) meshes.set(req.part, v);
      else meshes.delete(req.part);
      const { mesh, ...meta } = v;
      return { ok: true, value: meta };
    }
    // overlap volumes only: their meshes are for the viewer
    if (req.op === "interferences" && Array.isArray(v)) return { ok: true, value: v.map(({ mesh, ...x }: any) => x) };
    return { ok: true, value: v };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e), timeout: !!e?.timeout };
  }
};

(globalThis as any).poolMeshes = meshes;
(globalThis as any).poolReady = ready.then((info) => info);
