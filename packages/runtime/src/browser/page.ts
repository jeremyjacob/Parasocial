// Engine page (runs in the cross-origin iframe). Owns the engine workers and a warm spare;
// relays requests from the app's MessagePort; kills and replaces a worker on timeout, when it
// crashes, and when its kernel faults (a WebAssembly trap leaves OCCT's memory corrupt) (§5, §7).
// A replacement gets the document state back (quietly: no script runs until the next request);
// on a kernel fault the requests still waiting go to it too, since the one that hit the fault has
// its answer already. Replacements back off while crashes repeat, so a crash loop can't spin.
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
  /** null until a delayed (backed-off) replacement starts */
  worker: Worker | null;
  ready: Promise<any>;
  /** messages held until the worker has its init (which waits for the compiled WASM) */
  backlog: unknown[] | null;
  /** regenerations sent and not answered */
  busy: number;
  /** part -> key of the shape adopted from its owner */
  adopted: Map<string, string>;
  /** the worker failed to start or crashed */
  failed: boolean;
  /** the slot's message handler, once attached (set on the worker when it starts) */
  onmessage?: (ev: MessageEvent) => void;
  /** what the worker is computing (its "op" messages), for timeout messages */
  progress?: Progress;
};
type Pending = { slot: Slot; timer: any; req: any; internal?: (m: any) => void };

type OpInfo = { part: string; type: string; tag?: string; source?: { file: string; line: number }; ms?: number };
type Progress = { current: null | { op: OpInfo; at: number }; slowest: OpInfo | null; opsMs: number; count: number };
const noProgress = (): Progress => ({ current: null, slowest: null, opsMs: 0, count: 0 });

function track(p: Progress, phase: "start" | "end", op: OpInfo) {
  if (phase === "start") return void (p.current = { op, at: Date.now() });
  p.current = null;
  p.count++;
  p.opsMs += op.ms ?? 0;
  if (!p.slowest || (op.ms ?? 0) > (p.slowest.ms ?? 0)) p.slowest = op;
}

/**
 * Why a request ran out of time: the geometry operation that was running (with its source line),
 * or, when none was, that script code may loop forever. (Same wording as the engine pool's.)
 */
function timeoutMessage(req: any, limitMs: number, progress: Progress): string {
  const what = req.op === "regenerate" || req.op === "regenerateSnapshot" ? `regeneration${req.part ? ` of ${req.part}` : ""}` : "loading the scripts";
  const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const name = (op: OpInfo) => `${op.type}${op.tag ? ` "${op.tag}"` : ""}${op.source ? ` at ${op.source.file}:${op.source.line}` : ""}`;
  const head = `${what} timed out after ${limitMs / 1000} s (the time limit)`;
  const { current, slowest, opsMs, count } = progress;
  const done = count ? `; ${count} geometry operation${count === 1 ? "" : "s"} finished before it in ${s(opsMs)}${slowest && (slowest.ms ?? 0) >= 100 ? ` (slowest: ${name(slowest)}, ${s(slowest.ms!)})` : ""}` : "";
  if (current) return `${head} while ${name(current.op)} was running (${s(Date.now() - current.at)} so far)${done}. The geometry is too heavy, not looping: simplify that operation (fewer or smaller tools per boolean, smaller fillets) or split the work`;
  if (count && opsMs >= limitMs / 2) return `${head}: geometry operations took ${s(opsMs)} of it${done}. Reduce the number or size of operations`;
  return `${head}: no geometry operation was running, so ${what === "loading the scripts" ? "a script may loop forever at its top level" : "the script may loop forever"}${done}`;
}

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
const PART_OPS = new Set(["regenerate", "drawing", "names", "describe", "fromOperation", "query", "resolve", "resolveOne", "indexOfName", "check", "describeAll", "tangentChain", "loopOf", "opsAtLine", "closestPoint"]);
const STATE_OPS = new Set(["setDocument", "setScript", "setOverrides", "setPoses"]);
/** Requests that run user script code: the watchdog covers them once the worker says "started". */
const WATCHED = new Set(["regenerate", "regenerateSnapshot", "setDocument", "setScript", "parts", "snapshotParts", "affected", "assemblies", "evaluate"]);
const CRASH_WINDOW_MS = 60_000;
/** When workers were replaced recently (crash-loop backoff). */
const crashes: number[] = [];

// Compile the kernel once for every worker (each compiling its own copy slows startup with several).
const useThreads = threads && (globalThis as any).crossOriginIsolated === true && typeof SharedArrayBuffer !== "undefined";
const compiled: Promise<WebAssembly.Module | undefined> =
  typeof fetch === "function" ? WebAssembly.compileStreaming(fetch(useThreads ? cfg.assets.wasmMulti : cfg.assets.wasmSingle)).catch(() => undefined) : Promise.resolve(undefined);

/** A worker slot; with `delay`, its worker starts later (messages wait in the backlog meanwhile). */
function spawn(delay = 0): Slot {
  let resolveReady!: (v: unknown) => void, rejectReady!: (e: Error) => void;
  const ready = new Promise((resolve, reject) => ((resolveReady = resolve), (rejectReady = reject)));
  const slot: Slot = { worker: null, ready, backlog: [], busy: 0, adopted: new Map(), failed: false };
  ready.catch(() => {});
  const start = () => {
    // content-versioned so a cached worker never outlives its build
    const worker = new Worker(new URL(`./worker.js?v=${cfg.assets.build}`, location.href), { type: "module", name: "parasocial-engine" });
    slot.worker = worker;
    const onMsg = (ev: MessageEvent) => {
      if (ev.data?.type === "ready") {
        worker.removeEventListener("message", onMsg);
        resolveReady(ev.data.info);
      } else if (ev.data?.type === "fatal") crashed(slot, `the engine failed to start: ${ev.data.error}`);
    };
    worker.addEventListener("message", onMsg);
    // a worker whose module fails to load or evaluate never posts anything, and one that throws
    // outside a request dies: surface both instead of hanging
    worker.addEventListener("error", (ev: any) => {
      ev?.preventDefault?.();
      crashed(slot, `the engine crashed: ${ev?.message || "the engine worker failed to load"}`);
    });
    if (slot.onmessage) worker.onmessage = slot.onmessage;
    compiled.then((wasmModule) => {
      if (slot.failed) return;
      worker.postMessage({ type: "init", threads, ...cfg.assets, wasmModule });
      for (const m of slot.backlog!) worker.postMessage(m);
      slot.backlog = null;
    });
  };
  const crashed = (s: Slot, message: string) => {
    if (s.failed) return;
    s.failed = true;
    rejectReady(new Error(message));
    if (spare === s) spare = null;
    else if (slots.includes(s)) replaceWorker(s, { message }, false);
  };
  if (delay > 0) setTimeout(start, delay);
  else start();
  return slot;
}

function postTo(slot: Slot, m: unknown) {
  if (slot.backlog) slot.backlog.push(m);
  else slot.worker!.postMessage(m);
}

function attach(slot: Slot) {
  slot.onmessage = (ev) => {
    if (!slots.includes(slot)) return;
    const m = ev.data;
    if (m?.type === "started") {
      const p = pending.get(m.id);
      if (p && p.slot === slot && p.timer === null && WATCHED.has(p.req.op)) {
        const progress = (slot.progress = noProgress());
        p.timer = setTimeout(() => replaceWorker(slot, { message: timeoutMessage(p.req, cfg.timeoutMs, progress), timeout: true }, false), cfg.timeoutMs);
      }
      return;
    }
    if (m?.type === "op") return void (slot.progress && track(slot.progress, m.phase, m.op));
    // the kernel faulted: whatever it answered before this stands; everything still waiting goes to a replacement
    if (m?.type === "poisoned") return replaceWorker(slot, { message: `the geometry kernel crashed (${m.error})` }, true);
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
  if (slot.worker) slot.worker.onmessage = slot.onmessage;
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

/** Document state as one quiet setDocument (plus poses): restores, runs no script code. */
function replay(): any[] {
  const [first, ...rest] = docState;
  let out: any[];
  if (first?.op !== "setDocument") out = docState.map((r) => (r.op === "setScript" ? { ...r, quiet: true } : r));
  else {
    const scripts = { ...first.doc.scripts };
    const overrides = { ...(first.doc.overrides ?? {}) };
    for (const r of rest) {
      if (r.op === "setScript") r.content === null ? delete scripts[r.path] : (scripts[r.path] = r.content);
      else if (r.op === "setOverrides") overrides[r.part] = r.overrides;
    }
    out = [{ op: "setDocument", doc: { ...first.doc, scripts, overrides }, quiet: true }];
  }
  return poses ? [...out, poses] : out;
}

/**
 * Kill a worker and put the warm spare (or a new worker) in its place with the document state.
 * Its requests fail with `error` (timeout, crash), or with `resend` go to the replacement (kernel fault).
 */
function replaceWorker(slot: Slot, error: { message: string; timeout?: boolean }, resend: boolean) {
  const i = slots.indexOf(slot);
  if (i < 0) return;
  slot.failed = true;
  slot.worker?.terminate();
  const now = Date.now();
  crashes.push(now);
  while (crashes.length && now - crashes[0] > CRASH_WINDOW_MS) crashes.shift();
  // the first replacement in a while is immediate; repeated ones back off (250 ms, 500 ms… 30 s)
  const delay = crashes.length <= 1 ? 0 : Math.min(30_000, 250 * 2 ** (crashes.length - 2));
  const next = delay === 0 && spare && !spare.failed ? spare : spawn(delay);
  if (next === spare || spare?.failed) spare = null;
  spare ??= spawn(delay);
  slots[i] = next;
  attach(next);
  for (const [part, s] of owner) if (s === slot) owner.delete(part);
  for (const r of replay()) postTo(next, { id: -1, req: r });
  for (const [id, p] of pending) {
    if (p.slot !== slot) continue;
    clearTimeout(p.timer);
    p.timer = null;
    if (resend) {
      p.slot = next;
      if (p.req.op === "regenerate") next.busy++;
      postTo(next, { id, req: p.req });
      continue;
    }
    pending.delete(id);
    const reply = { type: "result", id, ok: false, error: error.message, ...(error.timeout ? { timeout: true } : {}) };
    if (p.internal) p.internal(reply);
    else port?.postMessage(reply);
  }
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
  else if (op === "measure" || op === "interference" || op === "interferencePairs" || op === "overlapPairs" || op === "distancePairs" || op === "interferences" || op === "export") {
    const parts: string[] = op === "measure" ? [req.a.part, req.b.part] : op === "interference" ? [req.a, req.b] : op === "interferencePairs" || op === "overlapPairs" || op === "distancePairs" ? [...new Set<string>(req.pairs.flat())] : op === "interferences" ? req.parts : (req.parts ?? (req.part ? [req.part] : []));
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
