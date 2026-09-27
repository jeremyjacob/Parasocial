// M0 spike: app origin (cross-origin isolated) -> engine iframe (other origin) -> worker (OCCT).
import { EngineClient } from "@parasocial/runtime/browser/client";
import { Viewer, LIGHT } from "../src";

declare const SCRIPTS: Record<string, Record<string, string>>;
const q = new URLSearchParams(location.search);
const doc = q.get("doc") ?? "bracket";
const threads = q.get("threads") === "1";
const m0: any = ((window as any).__m0 = { appIsolated: (self as any).crossOriginIsolated, t0: performance.now() });

const el = document.getElementById("vp")!;
const viewer = new Viewer(el, { theme: LIGHT, preserveDrawingBuffer: true });
(window as any).__viewer = viewer;
const engine = new EngineClient({ engineUrl: `http://localhost:5181/?threads=${threads ? 1 : 0}` });
const info = await engine.ready;
m0.engine = info;
m0.readyMs = performance.now() - m0.t0;
const scripts = (window as any).SCRIPTS[doc];
const parts = await engine.setDocument({ scripts });
m0.regen = [];
const palette = ["#7c8aa5", "#8fa89a", "#b59f7b", "#9c8fb5", "#7fa3b0"];
for (const [i, p] of parts.entries()) {
  const t = performance.now();
  const r = (await engine.regenerate(p))!;
  const rtt = performance.now() - t;
  m0.regen.push({ part: p, ok: r.ok, engineMs: r.timings.total, rttMs: rtt, faces: r.faces.length, problems: r.problems });
  viewer.setPart({ id: p, mesh: r.mesh!, faceEdges: r.faceEdges, hiddenEdges: new Set(r.edges.flatMap((e, j) => (e.seam ? [j] : []))), color: palette[i % palette.length], appearance: r.appearance, dim: !r.ok });
}
viewer.setView("iso", false);
m0.stats = await (engine as any).call({ op: "ping" });
// warm param change
if (doc === "bracket") {
  await engine.setOverrides("bracket", { width: 52 });
  const t = performance.now();
  const r = (await engine.regenerate("bracket", "coarse"))!;
  m0.warmParamMs = performance.now() - t;
  viewer.setPart({ id: "bracket", mesh: r.mesh!, faceEdges: r.faceEdges, color: palette[0] });
}
el.addEventListener("pointermove", (e) => {
  const rect = el.getBoundingClientRect();
  viewer.setPreselect(viewer.pick(e.clientX - rect.left, e.clientY - rect.top));
});
el.addEventListener("click", async (e) => {
  const rect = el.getBoundingClientRect();
  const t = performance.now();
  const ref = viewer.pick(e.clientX - rect.left, e.clientY - rect.top);
  viewer.setSelection(ref ? [ref] : []);
  m0.lastSelect = ref;
  if (ref && ref.kind !== ("part" as any)) m0.lastDescribe = await engine.describe(ref.part, ref.kind, ref.index);
  m0.selectMs = performance.now() - t;
});
m0.done = true;
