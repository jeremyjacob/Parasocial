// Engine page (runs in the cross-origin iframe). Owns the engine workers and a warm spare;
// relays requests from the app's MessagePort; kills and replaces a worker on timeout (§5, §7).
// Parts regenerate in parallel: each part belongs to one worker (the first idle one when it's
// first asked for), document state goes to every worker, and cross-part requests (measure,
// interference, export) run on worker 0 after it adopts the other workers' shapes as B-rep.
import type { WorkerInit } from "./worker";
import { sourcePart } from "../protocol";

declare const ENGINE_CONFIG: { allowedParents: string[]; assets: Omit<WorkerInit, "type" | "threads">; timeoutMs: number };
const cfg = (globalThis as any).ENGINE_CONFIG as typeof ENGINE_CONFIG;

const params = new URLSearchParams(location.search);
const threads = params.get("threads") === "1";
/** Two cores stay free for the app and the browser; beyond four, memory grows faster than regeneration speeds up. */
const COUNT = Math.min(8, Math.max(1, Number(params.get("workers")) || Math.min(4, (navigator.hardwareConcurrency || 2) - 2)));

type Slot = {
  worker: Worker;
  ready: Promise<any>;
  /** messages held until the worker has its init (which waits for the compiled WASM) */
  backlog: unknown[] | null;
  /** regenerations sent and not answered */
  busy: number;
  /** part -> key of the shape adopted from its owner */
  adopted: Map<string, string>;
};
type Pending = { slot: Slot; timer: any; req: any; internal?: (m: any) => void };

const slots: Slot[] = [];
let spare: Slot | null = null;
let port: MessagePort | null = null;
/** Messages that define document state, replayed into a replacement worker. */
let docState: any[] = [];
let poses: any = null;
const pending = new Map<number, Pending>();
/** Requests the page makes itself; the app's ids are positive (-1 is a replay). */
let internalId = -2;

/** Part (source part id) -> the worker that regenerates it. */
const owner = new Map<string, Slot>();
/** Part -> key of its latest regeneration (to know when an adopted copy is stale). */
const keys = new Map<string, string>();
/** Requests for parts no worker has yet, in arrival order. */
const waiting = new Map<string, { id: number; req: any }[]>();

/** Requests about one part: they go to the worker that owns it. */
const PART_OPS = new Set(["regenerate", "names", "describe", "fromOperation", "query", "resolve", "resolveOne", "indexOfName", "check", "describeAll", "tangentChain", "loopOf", "opsAtLine", "closestPoint"]);
const STATE_OPS = new Set(["setDocument", "setScript", "setOverrides", "setPoses"]);

// Compile the kernel once for every worker (each compiling its own copy slows startup with several).
const useThreads = threads && (globalThis as any).crossOriginIsolated === true && typeof SharedArrayBuffer !== "undefined";
const compiled: Promise<WebAssembly.Module | undefined> =
  typeof fetch === "function" ? WebAssembly.compileStreaming(fetch(useThreads ? cfg.assets.wasmMulti : cfg.assets.wasmSingle)).catch(() => undefined) : Promise.resolve(undefined);

function spawn(): Slot {
  // content-versioned so a cached worker never outlives its build
  const worker = new Worker(new URL(`./worker.js?v=${cfg.assets.build}`, location.href), { type: "module", name: "parasocial-engine" });
  const ready = new Promise((resolve, reject) => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.data?.type === "ready") {
        worker.removeEventListener("message", onMsg);
        resolve(ev.data.info);
      } else if (ev.data?.type === "fatal") reject(new Error(ev.data.error));
    };
    worker.addEventListener("message", onMsg);
    // a worker whose module fails to load or evaluate never posts anything: surface it instead of hanging
    worker.addEventListener("error", (ev) => reject(new Error(ev.message || "the engine worker failed to load")), { once: true });
  });
  ready.catch(() => {});
  const slot: Slot = { worker, ready, backlog: [], busy: 0, adopted: new Map() };
  compiled.then((wasmModule) => {
    worker.postMessage({ type: "init", threads, ...cfg.assets, wasmModule });
    for (const m of slot.backlog!) worker.postMessage(m);
    slot.backlog = null;
  });
  return slot;
}

function postTo(slot: Slot, m: unknown) {
  if (slot.backlog) slot.backlog.push(m);
  else slot.worker.postMessage(m);
}

function attach(slot: Slot) {
  slot.worker.onmessage = (ev) => {
    if (!slots.includes(slot)) return;
    const m = ev.data;
    if (m?.type === "started") {
      const p = pending.get(m.id);
      if (p && p.timer === null && (p.req.op === "regenerate" || p.req.op === "regenerateSnapshot")) p.timer = setTimeout(() => replaceWorker(slot), cfg.timeoutMs);
      return;
    }
    if (m?.type !== "result") return;
    const p = pending.get(m.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(m.id);
    if (p.req.op === "regenerate") {
      slot.busy--;
      const part = sourcePart(p.req.part);
      if (m.ok && m.value) m.value.key ? keys.set(part, m.value.key) : keys.delete(part);
      dispatch();
    }
    if (p.internal) return p.internal(m);
    port?.postMessage(m, collectTransfer(m.value));
  };
}

function collectTransfer(v: any): Transferable[] {
  const out: Transferable[] = [];
  const mesh = v?.mesh;
  if (mesh) for (const k of ["positions", "normals", "indices", "faceRanges", "edgePositions", "edgeRanges"]) if (mesh[k]?.buffer) out.push(mesh[k].buffer);
  return out;
}

function post(slot: Slot, id: number, req: any, internal?: (m: any) => void) {
  pending.set(id, { slot, timer: null, req, internal });
  if (req.op === "regenerate") slot.busy++;
  postTo(slot, { id, req });
}

/** A request of the page's own; resolves with the worker's result message. */
function ask(slot: Slot, req: any): Promise<any> {
  return new Promise((resolve) => post(slot, internalId--, req, resolve));
}

/** Give waiting parts to idle workers, in the order they were first asked for. */
function dispatch() {
  for (const [part, msgs] of waiting) {
    const idle = slots.find((s) => s.busy === 0);
    if (!idle) return;
    owner.set(part, idle);
    waiting.delete(part);
    for (const m of msgs) post(idle, m.id, m.req);
  }
}

async function replaceWorker(slot: Slot) {
  // a runaway script: kill the worker, promote the warm spare, replay document state, fail its requests
  const i = slots.indexOf(slot);
  if (i < 0) return;
  slot.worker.terminate();
  const error = `regeneration timed out after ${cfg.timeoutMs / 1000} s: the script may loop forever`;
  for (const [id, p] of pending) {
    if (p.slot !== slot) continue;
    clearTimeout(p.timer);
    pending.delete(id);
    if (p.internal) p.internal({ type: "result", id, ok: false, error, timeout: true });
    else port?.postMessage({ type: "result", id, ok: false, error, timeout: true });
  }
  const next = spare ?? spawn();
  spare = spawn();
  slots[i] = next;
  attach(next);
  for (const [part, s] of owner) if (s === slot) owner.delete(part);
  for (const r of poses ? [...docState, poses] : docState) postTo(next, { id: -1, req: r });
  dispatch();
}

/** Cross-part requests run one at a time on worker 0, in order (interference results are latest-wins). */
let crossChain: Promise<void> = Promise.resolve();

async function cross(m: { id: number; req: any }, parts: string[]) {
  const hub = slots[0];
  for (const part of new Set(parts.map(sourcePart))) {
    const s = owner.get(part);
    if (!s || s === hub) continue;
    const key = keys.get(part);
    if (key !== undefined && hub.adopted.get(part) === key) continue;
    const r = await ask(s, { op: "shapeOf", part });
    if (!r.ok || !r.value || !slots.includes(hub)) continue;
    post(hub, internalId--, { op: "adopt", part, key: r.value.key, brep: r.value.brep }, () => {});
    hub.adopted.set(part, r.value.key);
  }
  post(slots[0], m.id, m.req);
}

async function affected(m: { id: number; req: any }) {
  // each worker knows the dependencies of the parts it regenerated, and calls every other part affected
  const rs = await Promise.all(slots.map((s) => ask(s, m.req)));
  const bad = rs.find((r) => !r.ok);
  if (bad) return port?.postMessage({ ...bad, id: m.id });
  const value = (rs[0].value as string[]).filter((p) => rs.every((r) => r.value.includes(p)));
  port?.postMessage({ type: "result", id: m.id, ok: true, value });
}

function send(m: { id: number; req: any }) {
  if (!slots.length) return;
  const req = m.req;
  const op = req.op;
  if (STATE_OPS.has(op)) {
    if (op === "setDocument") docState = [req];
    else if (op === "setPoses") poses = req;
    else docState.push(req);
    slots.forEach((s, i) => (i === 0 ? post(s, m.id, req) : post(s, internalId--, req, () => {})));
  } else if (PART_OPS.has(op)) {
    const part = sourcePart(req.part);
    const s = owner.get(part);
    if (s) return post(s, m.id, req);
    const q = waiting.get(part);
    if (q) q.push(m);
    else waiting.set(part, [m]);
    dispatch();
  } else if (op === "affected") affected(m);
  else if (op === "measure" || op === "interference" || op === "interferences" || op === "export") {
    const parts: string[] = op === "measure" ? [req.a.part, req.b.part] : op === "interference" ? [req.a, req.b] : op === "interferences" ? req.parts : (req.parts ?? (req.part ? [req.part] : []));
    crossChain = crossChain.then(() => cross(m, parts)).catch(() => {});
  } else post(slots[0], m.id, req);
}

window.addEventListener("message", async (ev) => {
  if (!cfg.allowedParents.includes(ev.origin) && !cfg.allowedParents.includes("*")) return;
  if (ev.data?.type !== "connect" || !(ev.ports[0] instanceof MessagePort)) return;
  port = ev.ports[0];
  port.onmessage = (e) => {
    const m = e.data;
    if (typeof m?.id === "number" && m.id > 0 && m.req && typeof m.req.op === "string") send(m);
  };
  try {
    const info = await slots[0].ready;
    port.postMessage({ type: "ready", info: { ...info, workers: slots.length } });
  } catch (e) {
    port.postMessage({ type: "result", id: 0, ok: false, error: String(e) });
  }
});

// precache the WASM for repeat visits (§9); failures are harmless
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});

// start warming immediately (the app starts the iframe on hover, §9); the spare boots after
for (let i = 0; i < COUNT; i++) slots.push(spawn());
slots.forEach(attach);
Promise.all(slots.map((s) => s.ready))
  .then(() => (spare ??= spawn()))
  .catch(() => {});
window.parent.postMessage({ type: "engine-loaded" }, "*");
