// Engine pool (§3): headless Chromium running the same engine build as the browser, for MCP
// calls (write results, render, measure, describe…). One browser process per active document
// (pinned while active, so its per-op cache stays warm); idle documents are recycled. Pages
// have no network access beyond this server. MCP never depends on a browser tab being open.
import { chromium, type Browser, type Page } from "playwright";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { buildEngine, type EngineAssets } from "@parasocial/runtime/server/build";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.POOL_PORT ?? 5190);
const MAX_DOCS = Number(process.env.POOL_MAX_DOCS ?? 4);
const IDLE_MS = Number(process.env.POOL_IDLE_MS ?? 10 * 60_000);
const TIMEOUT_MS = Number(process.env.POOL_REGEN_TIMEOUT_MS ?? 10_000);
const ORIGIN = `http://127.0.0.1:${PORT}`;

type Slot = { browser: Browser; page: Page; lastUsed: number; busy: Promise<unknown>; scripts: Map<string, string>; overrides: string; units: string };
const slots = new Map<string, Slot>();

let assets: EngineAssets;
let pageJs = "";

async function build() {
  assets = await buildEngine(join(here, "../dist/engine"));
  const res = await Bun.build({ entrypoints: [join(here, "page.ts")], target: "browser", format: "esm", minify: true });
  if (!res.success) throw new AggregateError(res.logs, "pool page build failed");
  pageJs = await res.outputs[0].text();
}

const iso = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };

async function open(documentID: string): Promise<Slot> {
  // evict idle / least recently used documents
  for (const [id, s] of slots) if (Date.now() - s.lastUsed > IDLE_MS) await close(id);
  if (slots.size >= MAX_DOCS) {
    const lru = [...slots].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    if (lru) await close(lru[0]);
  }
  const browser = await chromium.launch({ args: ["--js-flags=--max-old-space-size=2048", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  // no egress: only this server is reachable
  await page.route("**/*", (route) => (route.request().url().startsWith(ORIGIN) ? route.continue() : route.abort()));
  page.on("pageerror", (e) => console.error(`[pool ${documentID.slice(0, 8)}] ${e.message}`));
  await page.goto(`${ORIGIN}/page.html`);
  await page.evaluate(() => (globalThis as any).poolReady);
  const slot: Slot = { browser, page, lastUsed: Date.now(), busy: Promise.resolve(), scripts: new Map(), overrides: "", units: "" };
  slots.set(documentID, slot);
  browser.on("disconnected", () => slots.get(documentID) === slot && slots.delete(documentID));
  return slot;
}

async function close(id: string) {
  const s = slots.get(id);
  slots.delete(id);
  await s?.browser.close().catch(() => {});
}

export type JobRequest = {
  document: string;
  scripts: Record<string, string>;
  overrides?: Record<string, Record<string, string | number>>;
  units?: string;
  ops: ({ op: string; [k: string]: unknown } | { op: "render"; [k: string]: unknown })[];
};

async function runJob(job: JobRequest) {
  let slot = slots.get(job.document) ?? (await open(job.document));
  slot.lastUsed = Date.now();
  const run = slot.busy.then(async () => {
    const page = slot.page;
    const rpc = (req: unknown) => page.evaluate((r) => (globalThis as any).rpc(r), req as any);
    // sync the document incrementally so the per-op cache survives across calls
    const overrides = JSON.stringify(job.overrides ?? {});
    const units = job.units ?? "mm";
    if (slot.units !== units || slot.scripts.size === 0) {
      await rpc({ op: "setDocument", doc: { scripts: job.scripts, overrides: job.overrides ?? {}, units: { length: units, angle: "deg" } } });
      slot.scripts = new Map(Object.entries(job.scripts));
      slot.overrides = overrides;
      slot.units = units;
    } else {
      for (const [p, c] of Object.entries(job.scripts)) if (slot.scripts.get(p) !== c) (await rpc({ op: "setScript", path: p, content: c }), slot.scripts.set(p, c));
      for (const p of [...slot.scripts.keys()]) if (!(p in job.scripts)) (await rpc({ op: "setScript", path: p, content: null }), slot.scripts.delete(p));
      if (slot.overrides !== overrides) {
        const o = job.overrides ?? {};
        const prev = JSON.parse(slot.overrides || "{}");
        for (const part of new Set([...Object.keys(o), ...Object.keys(prev)])) await rpc({ op: "setOverrides", part, overrides: o[part] ?? {} });
        slot.overrides = overrides;
      }
    }
    const results: unknown[] = [];
    for (const op of job.ops) {
      if (op.op === "render") {
        const url: string = await page.evaluate((o) => (globalThis as any).render(o), op as any);
        results.push({ ok: true, value: { png: url.slice(url.indexOf(",") + 1) } });
      } else results.push(await rpc(op));
    }
    return results;
  });
  slot.busy = run.catch(() => {});
  try {
    return await run;
  } catch (e) {
    // the page or browser died: drop it; the next job starts fresh
    await close(job.document);
    throw e;
  }
}

if (import.meta.main) {
  await build();
  if (process.env.POOL_WATCH === "1") {
    // dev: rebuild the engine + page when their sources change, and drop stale browsers
    const { watch } = await import("node:fs");
    let timer: any;
    for (const pkg of ["runtime/src", "kernel/src", "naming/src", "api/src", "viewer/src", "engine-pool/src"])
      watch(join(here, "../..", pkg), { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          try {
            await build();
            for (const id of [...slots.keys()]) await close(id);
            console.log(`pool rebuilt (${assets.build})`);
          } catch (e) {
            console.error("pool rebuild failed", e);
          }
        }, 200);
      });
  }
  const server = Bun.serve({
    port: PORT,
    hostname: process.env.POOL_HOST ?? "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/health") return Response.json({ ok: true, documents: slots.size, build: assets.build });
      if (u.pathname === "/page.html")
        return new Response(`<!doctype html><html><head><meta charset="utf-8"><script>window.POOL=${JSON.stringify({ assets: { glueSingle: "/engine" + assets.glueSingle, wasmSingle: "/engine" + assets.wasmSingle, glueMulti: "/engine" + assets.glueMulti, wasmMulti: "/engine" + assets.wasmMulti, build: assets.build }, timeoutMs: TIMEOUT_MS })}</script><script type="module" src="/page.js"></script></head><body style="margin:0"></body></html>`, { headers: { "Content-Type": "text/html", ...iso } });
      if (u.pathname === "/page.js") return new Response(pageJs, { headers: { "Content-Type": "text/javascript", ...iso } });
      if (u.pathname.startsWith("/engine/")) {
        const f = join(assets.dir, u.pathname.slice(8));
        if (!f.startsWith(assets.dir) || !existsSync(f)) return new Response("not found", { status: 404 });
        return new Response(Bun.file(f), { headers: { "Content-Type": f.endsWith(".wasm") ? "application/wasm" : "text/javascript", ...iso } });
      }
      if (u.pathname === "/v1/jobs" && req.method === "POST") {
        if (process.env.POOL_TOKEN && req.headers.get("authorization") !== `Bearer ${process.env.POOL_TOKEN}`) return new Response("unauthorized", { status: 401 });
        try {
          const job = (await req.json()) as JobRequest;
          return Response.json({ results: await runJob(job) });
        } catch (e) {
          return Response.json({ error: String((e as Error).message ?? e) }, { status: 500 });
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`engine pool on http://${server.hostname}:${server.port} (max ${MAX_DOCS} documents)`);
  const shutdown = async () => {
    for (const id of [...slots.keys()]) await close(id);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
