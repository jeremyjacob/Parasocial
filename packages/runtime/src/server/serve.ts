// The engine origin (§5 Sandboxing): a tiny static server on a separate origin with
// COOP/COEP/CORP (cross-origin isolated, for threads) and a CSP with no network access
// beyond its own static files. It serves no data and holds no credentials.
import { join, extname } from "node:path";
import { existsSync } from "node:fs";
import { buildEngine, type EngineAssets } from "./build";

export type EngineServerOptions = {
  port?: number;
  hostname?: string;
  /** App origins allowed to embed and talk to the engine. */
  allowedParents: string[];
  timeoutMs?: number;
  assets?: EngineAssets;
};

const TYPES: Record<string, string> = { ".js": "text/javascript", ".wasm": "application/wasm", ".html": "text/html; charset=utf-8" };

export function engineHeaders(allowedParents: string[], ext: string, immutable: boolean): Record<string, string> {
  const h: Record<string, string> = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  };
  if (ext === ".html" || ext === ".js") {
    // new Function (script modules) needs 'unsafe-eval'; connect-src 'self' only reaches this static server
    h["Content-Security-Policy"] = [
      "default-src 'none'",
      "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' blob:",
      "worker-src 'self' blob:",
      "connect-src 'self'",
      `frame-ancestors ${allowedParents.join(" ") || "'none'"}`,
    ].join("; ");
  }
  return h;
}

/**
 * Service worker on the engine origin (§9 Loading): precaches the content-hashed OCCT glue and
 * WASM so a repeat visit never downloads them again; cache-first for /occt/*.
 */
export function serviceWorker(a: EngineAssets): string {
  const files = [a.glueSingle, a.wasmSingle, `/worker.js?v=${a.build}`, `/page.js?v=${a.build}`];
  return `const CACHE = "ps-engine-${a.build}";
const PRECACHE = ${JSON.stringify(files)};
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith("ps-engine-") && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || !(u.pathname.startsWith("/occt/") || u.pathname === "/worker.js" || u.pathname === "/page.js")) return;
  e.respondWith(caches.open(CACHE).then(async (c) => (await c.match(e.request)) ?? fetch(e.request).then((r) => { if (r.ok && u.pathname.startsWith("/occt/")) c.put(e.request, r.clone()); return r; })));
});`;
}

export async function serveEngine(o: EngineServerOptions & { watch?: boolean }) {
  let assets = o.assets ?? (await buildEngine());
  const configFor = (assets: EngineAssets) => `window.ENGINE_CONFIG=${JSON.stringify({ allowedParents: o.allowedParents, timeoutMs: o.timeoutMs ?? 10000, assets: { glueSingle: assets.glueSingle, glueMulti: assets.glueMulti, wasmSingle: assets.wasmSingle, wasmMulti: assets.wasmMulti, build: assets.build } })};`;
  let config = configFor(assets);
  if (o.watch) {
    // dev: the worker is bundled at runtime, so watch the engine's sources and rebuild
    const { watch } = await import("node:fs");
    const { join: j, dirname: d } = await import("node:path");
    const { fileURLToPath: f } = await import("node:url");
    const pkgs = j(d(f(import.meta.url)), "../../..");
    let timer: any;
    for (const pkg of ["runtime/src", "kernel/src", "naming/src", "api/src", "viewer/src"])
      watch(j(pkgs, pkg), { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          try {
            assets = await buildEngine();
            config = configFor(assets);
            console.log(`engine rebuilt (${assets.build})`);
          } catch (e) {
            console.error("engine rebuild failed", e);
          }
        }, 150);
      });
  }
  return Bun.serve({
    port: o.port ?? 5181,
    hostname: o.hostname ?? "localhost",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
      let path = url.pathname === "/" ? "/index.html" : url.pathname;
      if (path === "/sw.js") return new Response(serviceWorker(assets), { headers: { "Content-Type": "text/javascript", "Service-Worker-Allowed": "/", ...engineHeaders(o.allowedParents, ".js", false) } });
      if (path === "/config.js") return new Response(config, { headers: { "Content-Type": "text/javascript", ...engineHeaders(o.allowedParents, ".js", false) } });
      if (path.includes("..")) return new Response("bad path", { status: 400 });
      const file = join(assets.dir, path);
      if (!existsSync(file)) return new Response("not found", { status: 404 });
      const ext = extname(file);
      if (ext === ".wasm" && (req.headers.get("accept-encoding") ?? "").includes("br") && existsSync(file + ".br")) {
        return new Response(Bun.file(file + ".br"), { headers: { "Content-Type": TYPES[ext], "Content-Encoding": "br", Vary: "Accept-Encoding", ...engineHeaders(o.allowedParents, ext, true) } });
      }
      return new Response(Bun.file(file), { headers: { "Content-Type": TYPES[ext] ?? "application/octet-stream", ...engineHeaders(o.allowedParents, ext, path.startsWith("/occt/")) } });
    },
  });
}

if (import.meta.main) {
  const port = Number(process.env.ENGINE_PORT ?? 5181);
  const parents = (process.env.APP_ORIGINS ?? "http://localhost:5173").split(",");
  const s = await serveEngine({ port, hostname: process.env.ENGINE_HOSTNAME, allowedParents: parents, watch: process.env.ENGINE_WATCH === "1" });
  console.log(`engine origin on http://localhost:${s.port} (parents: ${parents.join(", ")})`);
}
