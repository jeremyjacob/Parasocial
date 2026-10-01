// Engine worker (same build as the browser) with a regeneration watchdog, for the Deno host.
// Written as a script over globals (POOL, Worker) so the timeout tests can run it with fakes.
declare const POOL: { worker: string; init: Record<string, unknown>; timeoutMs: number };
const cfg = (globalThis as any).POOL as typeof POOL;

let worker: Worker;
let ready: Promise<any>;
let nextId = 1;
const pending = new Map<number, { start: () => void; resolve: (v: any) => void; reject: (e: Error) => void }>();
let docState: any[] = [];
const meshes = new Map<string, any>(); // last regeneration result per part (with mesh), for renders

function spawn() {
  worker = new Worker(cfg.worker, { type: "module" });
  const spawned = worker;
  ready = new Promise((resolve, reject) => {
    worker.onmessage = (ev) => {
      if (spawned !== worker) return;
      const m = ev.data;
      if (m?.type === "ready") return resolve(m.info);
      if (m?.type === "fatal") return reject(new Error(m.error));
      if (m?.type === "started") return pending.get(m.id)?.start();
      if (m?.type === "result") {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        m.ok ? p.resolve(m.value) : p.reject(new Error(m.error));
      }
    };
  });
  worker.postMessage({ type: "init", threads: false, ...cfg.init });
}
spawn();

async function call(req: any): Promise<any> {
  await ready;
  if (req.op === "setDocument") docState = [req];
  else if (req.op === "setScript" || req.op === "setOverrides") docState.push(req);
  const id = nextId++;
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const start = () => {
      if (timer !== null || (req.op !== "regenerate" && req.op !== "regenerateSnapshot")) return;
      timer = setTimeout(() => {
        // Every pending call belongs to the terminated worker, including queued calls.
        worker.terminate();
        const error = Object.assign(new Error(`regeneration timed out after ${cfg.timeoutMs / 1000} s: the script may loop forever`), { timeout: true });
        for (const p of pending.values()) p.reject(error);
        pending.clear();
        spawn();
        for (const r of docState) worker.postMessage({ id: -1, req: r });
      }, cfg.timeoutMs);
    };
    pending.set(id, { start, resolve: (v) => (timer !== null && clearTimeout(timer), resolve(v)), reject: (e) => (timer !== null && clearTimeout(timer), reject(e)) });
    worker.postMessage({ id, req });
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
