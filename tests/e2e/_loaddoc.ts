// Time opening a zip-exported document: `bun tests/e2e/_loaddoc.ts <zip> <studio file>` (dev stack running).
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { virtualAuthenticator, signUp } from "./auth";
const [zip, studio] = process.argv.slice(2);
const b = await chromium.launch({ channel: process.env.PW_CHANNEL, args: ["--use-angle=metal", "--ignore-gpu-blocklist"] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("console", (m) => m.text().startsWith("[T]") && console.log(m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.addInitScript(() => {
  const orig = MessagePort.prototype.postMessage;
  const log: any[] = ((globalThis as any).__reqs = []);
  MessagePort.prototype.postMessage = function (m: any, ...rest: any[]) {
    if (m?.req?.op) log.push([Math.round(performance.now()), m.req.op, m.req.part ?? ""]);
    return (orig as any).call(this, m, ...rest);
  };
});
await virtualAuthenticator(page);
await signUp(page, "Load Timer");
const bytes = [...readFileSync(zip)];
const id = await page.evaluate(async (bs) => {
  const res = await fetch("/api/documents/import", { method: "POST", body: new Uint8Array(bs), headers: { "Content-Type": "application/zip" } });
  const j = await res.json();
  return j.id ?? j.documentID;
}, bytes);
await page.evaluate(([id, s]) => localStorage.setItem(`parasocial:studio:${id}`, s), [id, studio]);
for (const run of ["first open", "reload"]) {
  const cdp = await page.context().newCDPSession(page);
  if (run === "reload") { await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 200 }); await cdp.send("Profiler.start"); }
  await page.goto(`http://localhost:5173/d/${id}`);
  const t = await page.evaluate(() => new Promise<any>((res) => {
    const start = performance.now();
    const out: any = {};
    const tick = () => {
      const ws = (globalThis as any).__ws;
      const now = performance.now();
      if (ws?.kernelReady) {
        out.kernel ??= now;
        const parts = Object.keys(ws.results ?? {});
        const live = (p: string) => ws.results[p] && !ws.results[p].fromCache && !ws.results[p].empty && ws.regen?.[p] !== "running";
        const shown: string[] = ws.shownSources ?? [];
        if (parts.length > 5 && shown.length && shown.every(live)) out.shown ??= now;
        if (parts.length > 5 && ws.parts.every(live)) { out.all = now; out.n = ws.parts.length; out.nShown = shown.length; return res(out); }
      }
      if (now - start > 60000) return res({ ...out, timeout: true, stuck: ws.parts.filter((p: string) => !(ws.results[p] && !ws.results[p].fromCache && !ws.results[p].empty && ws.regen?.[p] !== "running")).slice(0, 8).map((p: string) => [p, ws.regen?.[p], ws.results[p]?.fromCache, ws.results[p]?.empty, ws.results[p]?.problems?.[0]?.message?.slice(0, 200)]) });
      setTimeout(tick, 10);
    };
    tick();
  }));
  if (run === "reload") {
    const { profile } = await cdp.send("Profiler.stop");
    const self = new Map<string, number>(); const byId = new Map(profile.nodes.map((n: any) => [n.id, n]));
    const dt = profile.timeDeltas; 
    profile.samples.forEach((id: number, i: number) => { const n: any = byId.get(id); const f = n.callFrame; const k = `${f.functionName || "(anon)"} ${f.url.split("/").slice(-2).join("/").split("?")[0]}:${f.lineNumber}`; self.set(k, (self.get(k) ?? 0) + (dt[i] ?? 0) / 1000); });
    console.log([...self].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => `${v.toFixed(0).padStart(6)} ms  ${k}`).join("\n"));
    // inclusive time by function
    const parent = new Map<number, number>(); for (const n of profile.nodes as any[]) for (const c of n.children ?? []) parent.set(c, n.id);
    const incl = new Map<string, number>();
    profile.samples.forEach((id: number, i: number) => { const seen = new Set<string>(); for (let x: any = id; x !== undefined; x = parent.get(x)) { const f = (byId.get(x) as any).callFrame; const k = `${f.functionName || "(anon)"} ${f.url.split("/").slice(-1)[0].split("?")[0]}:${f.lineNumber}`; if (!seen.has(k)) { seen.add(k); incl.set(k, (incl.get(k) ?? 0) + (dt[i] ?? 0) / 1000); } } });
    console.log("--- inclusive");
    console.log([...incl].filter(([k]) => !k.startsWith("(")).sort((a, b) => b[1] - a[1]).slice(0, 45).map(([k, v]) => `${v.toFixed(0).padStart(6)} ms  ${k}`).join("\n"));
  }
  const rq: any[] = await page.evaluate(() => (globalThis as any).__reqs);
  const c: Record<string, number> = {}; for (const [, op] of rq) c[op] = (c[op] ?? 0) + 1;
  console.log(run, "requests:", JSON.stringify(c), "first:", rq.filter(([, op]) => op !== "regenerate" && op !== "names").slice(0, 12).map((r) => r.join(" ")).join(" | "));
  console.log(`${run}: kernel ${t.kernel?.toFixed(0)} ms, shown studio (${t.nShown} parts) ${t.shown?.toFixed(0)} ms, all ${t.n} parts ${t.all?.toFixed(0)} ms${t.timeout ? " TIMEOUT " + JSON.stringify(t.stuck) : ""}`);
}
const reqs: any[] = await page.evaluate(() => (globalThis as any).__reqs);
const counts: Record<string, number> = {};
for (const [t, op] of reqs) if (t < 6000) counts[op] = (counts[op] ?? 0) + 1;
console.log("requests in first 6 s of reload:", counts);
console.log(reqs.filter(([t, op]) => op !== "regenerate").slice(0, 40).map((r) => r.join(" ")).join("\n"));
console.log(await page.evaluate(async () => {
  const e = (globalThis as any).__ws.engine; const o: any = {};
  for (const op of ["assemblies", "builds", "assemblies", "builds"]) { const t = performance.now(); await e[op](); o[op] = (o[op] ?? "") + " " + (performance.now() - t).toFixed(0); }
  let t = performance.now(); await e.call({ op: "ping" }); o.ping = (performance.now() - t).toFixed(0);
  return o;
}));
await b.close();
