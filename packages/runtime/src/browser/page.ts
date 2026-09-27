// Engine page (runs in the cross-origin iframe). Owns the worker and a warm spare; relays
// requests from the app's MessagePort; kills and replaces the worker on timeout (§5, §7).
import type { WorkerInit } from "./worker";

declare const ENGINE_CONFIG: { allowedParents: string[]; assets: Omit<WorkerInit, "type" | "threads">; timeoutMs: number };
const cfg = (globalThis as any).ENGINE_CONFIG as typeof ENGINE_CONFIG;

type Slot = { worker: Worker; ready: Promise<any> };
let current: Slot | null = null;
let spare: Slot | null = null;
let port: MessagePort | null = null;
/** Messages that define document state, replayed into a replacement worker. */
let docState: any[] = [];
const pending = new Map<number, { timer: any; req: any }>();

function spawn(): Slot {
  const worker = new Worker(new URL("./worker.js", location.href), { type: "module", name: "parasocial-engine" });
  const ready = new Promise((resolve, reject) => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.data?.type === "ready") {
        worker.removeEventListener("message", onMsg);
        resolve(ev.data.info);
      } else if (ev.data?.type === "fatal") reject(new Error(ev.data.error));
    };
    worker.addEventListener("message", onMsg);
  });
  worker.postMessage({ type: "init", threads: new URLSearchParams(location.search).get("threads") === "1", ...cfg.assets });
  return { worker, ready };
}

function attach(slot: Slot) {
  slot.worker.onmessage = (ev) => {
    const m = ev.data;
    if (m?.type === "result") {
      const p = pending.get(m.id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(m.id);
      }
      const transfer = collectTransfer(m.value);
      port?.postMessage(m, transfer);
    }
  };
}

function collectTransfer(v: any): Transferable[] {
  const out: Transferable[] = [];
  const mesh = v?.mesh;
  if (mesh) for (const k of ["positions", "normals", "indices", "faceRanges", "edgePositions", "edgeRanges"]) if (mesh[k]?.buffer) out.push(mesh[k].buffer);
  return out;
}

async function replaceWorker() {
  // a runaway script: kill it, promote the warm spare, replay document state, fail pending requests
  current?.worker.terminate();
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    port?.postMessage({ type: "result", id, ok: false, error: `regeneration timed out after ${cfg.timeoutMs / 1000} s: the script may loop forever`, timeout: true });
  }
  pending.clear();
  current = spare ?? spawn();
  spare = spawn();
  attach(current);
  await current.ready;
  for (const m of docState) current.worker.postMessage({ id: -1, req: m });
}

function send(m: { id: number; req: any }) {
  if (!current) return;
  const op = m.req?.op;
  if (op === "setDocument") docState = [m.req];
  else if (op === "setScript" || op === "setOverrides") docState.push(m.req);
  const timer = op === "regenerate" ? setTimeout(replaceWorker, cfg.timeoutMs) : null;
  pending.set(m.id, { timer, req: m.req });
  current.worker.postMessage(m);
}

window.addEventListener("message", async (ev) => {
  if (!cfg.allowedParents.includes(ev.origin) && !cfg.allowedParents.includes("*")) return;
  if (ev.data?.type !== "connect" || !(ev.ports[0] instanceof MessagePort)) return;
  port = ev.ports[0];
  current ??= spawn();
  attach(current);
  port.onmessage = (e) => {
    const m = e.data;
    if (typeof m?.id === "number" && m.req && typeof m.req.op === "string") send(m);
  };
  try {
    const info = await current.ready;
    port.postMessage({ type: "ready", info });
  } catch (e) {
    port.postMessage({ type: "result", id: 0, ok: false, error: String(e) });
  }
});

// start warming immediately (the app starts the iframe on hover, §9); the spare boots after
current = spawn();
current.ready.then(() => (spare ??= spawn())).catch(() => {});
window.parent.postMessage({ type: "engine-loaded" }, "*");
