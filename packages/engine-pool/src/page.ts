// Pool page: runs the engine worker (same build as the browser) plus a viewer for renders.
// Driven by the pool server over Playwright's page.evaluate.
import { Viewer, LIGHT, type EntityRef } from "@parasocial/viewer";

declare const POOL: { assets: { glueSingle: string; wasmSingle: string; glueMulti: string; wasmMulti: string; build: string }; timeoutMs: number };
const cfg = (globalThis as any).POOL as typeof POOL;

let worker: Worker;
let ready: Promise<any>;
let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let docState: any[] = [];
const meshes = new Map<string, any>(); // last regeneration result per part (with mesh)

function spawn() {
  worker = new Worker("/engine/worker.js", { type: "module" });
  ready = new Promise((resolve, reject) => {
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m?.type === "ready") return resolve(m.info);
      if (m?.type === "fatal") return reject(new Error(m.error));
      if (m?.type === "result") {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        m.ok ? p.resolve(m.value) : p.reject(new Error(m.error));
      }
    };
  });
  worker.postMessage({ type: "init", threads: false, ...cfg.assets });
}
spawn();

async function call(req: any): Promise<any> {
  await ready;
  if (req.op === "setDocument") docState = [req];
  else if (req.op === "setScript" || req.op === "setOverrides") docState.push(req);
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = req.op === "regenerate" ? setTimeout(async () => {
      // runaway script: replace the worker, replay the document, fail this call
      pending.delete(id);
      worker.terminate();
      spawn();
      for (const r of docState) worker.postMessage({ id: -1, req: r });
      reject(Object.assign(new Error(`regeneration timed out after ${cfg.timeoutMs / 1000} s: the script may loop forever`), { timeout: true }));
    }, cfg.timeoutMs) : null;
    pending.set(id, { resolve: (v) => (timer && clearTimeout(timer), resolve(v)), reject: (e) => (timer && clearTimeout(timer), reject(e)) });
    worker.postMessage({ id, req });
  });
}

/** One engine request. Regeneration results keep their mesh in the page (for renders); metadata goes back. */
(globalThis as any).rpc = async (req: any) => {
  try {
    const v = await call(req);
    if (req.op === "regenerate" && v) {
      if (v.mesh) meshes.set(req.part, v);
      else meshes.delete(req.part);
      const { mesh, ...meta } = v;
      return { ok: true, value: meta };
    }
    return { ok: true, value: v };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e), timeout: !!e?.timeout };
  }
};

const PALETTE = ["#8e939a", "#93b29c", "#8d8fd6", "#d2c27f", "#5fa6a4", "#cf96a4"];

/** Render the current geometry to a PNG data URL. */
(globalThis as any).render = async (o: { parts?: string[]; view?: string; camera?: { position: number[]; target: number[]; up: number[]; ortho?: boolean }; highlight?: EntityRef[]; width?: number; height?: number; style?: "shaded" | "shadedEdges" | "wireframe" | "hiddenLine" }) => {
  const w = o.width ?? 1024,
    h = o.height ?? 768;
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;left:0;top:0;width:${w}px;height:${h}px`;
  document.body.appendChild(host);
  const v = new Viewer(host, { theme: LIGHT, viewCube: false, preserveDrawingBuffer: true, maxDpr: 1, reducedMotion: true });
  let i = 0;
  for (const [id, r] of meshes) {
    if (o.parts && !o.parts.includes(id)) continue;
    v.setPart({ id, mesh: r.mesh, faceEdges: r.faceEdges, hiddenEdges: new Set(r.edges.flatMap((e: any, j: number) => (e.seam ? [j] : []))), color: r.color?.kind === "rgb" ? r.color.hex : PALETTE[i++ % PALETTE.length] });
  }
  if (o.style) v.setDisplayMode(o.style);
  if (o.highlight?.length) v.setSelection(o.highlight);
  if (o.camera) v.setCameraState(o.camera as any, false);
  else v.setView((o.view as any) ?? "iso", false);
  v.renderNow();
  const url = v.canvas.toDataURL("image/png");
  v.dispose();
  host.remove();
  return url;
};

(globalThis as any).poolReady = ready.then((info) => info);
