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

export async function serveEngine(o: EngineServerOptions) {
  const assets = o.assets ?? (await buildEngine());
  const config = `window.ENGINE_CONFIG=${JSON.stringify({ allowedParents: o.allowedParents, timeoutMs: o.timeoutMs ?? 10000, assets: { glueSingle: assets.glueSingle, glueMulti: assets.glueMulti, wasmSingle: assets.wasmSingle, wasmMulti: assets.wasmMulti, build: assets.build } })};`;
  return Bun.serve({
    port: o.port ?? 5181,
    hostname: o.hostname ?? "localhost",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
      let path = url.pathname === "/" ? "/index.html" : url.pathname;
      if (path === "/config.js") return new Response(config, { headers: { "Content-Type": "text/javascript", ...engineHeaders(o.allowedParents, ".js", false) } });
      if (path.includes("..")) return new Response("bad path", { status: 400 });
      const file = join(assets.dir, path);
      if (!existsSync(file)) return new Response("not found", { status: 404 });
      const ext = extname(file);
      return new Response(Bun.file(file), { headers: { "Content-Type": TYPES[ext] ?? "application/octet-stream", ...engineHeaders(o.allowedParents, ext, path.startsWith("/occt/")) } });
    },
  });
}

if (import.meta.main) {
  const port = Number(process.env.ENGINE_PORT ?? 5181);
  const parents = (process.env.APP_ORIGINS ?? "http://localhost:5173").split(",");
  const s = await serveEngine({ port, allowedParents: parents });
  console.log(`engine origin on http://localhost:${s.port} (parents: ${parents.join(", ")})`);
}
