// Production build served locally for measurements (§9 budgets): the built app (adapter-bun) behind
// a small proxy on :5173 that routes /zero to zero-cache like Caddy does in deploy/, plus the engine
// origin on :5174, with the dev databases. `bun run build` in packages/app first.
import { join } from "node:path";
import { DEV_ENV } from "./dev";

const root = join(import.meta.dir, "..");
const env = { ...process.env, ...DEV_ENV, NODE_ENV: "production" };
const engine = Bun.spawn(["bun", join(root, "packages/runtime/src/server/serve.ts")], { env: { ...env, ENGINE_PORT: "5174", APP_ORIGINS: DEV_ENV.APP_ORIGIN }, stdout: "inherit", stderr: "inherit" });
const pool = Bun.spawn(["bun", join(root, "packages/engine-pool/src/server.ts")], { env: { ...env, POOL_PORT: "5190" }, stdout: "inherit", stderr: "inherit" });
const APP_PORT = 5176;
const app = Bun.spawn(["bun", join(root, "packages/app/build/index.js")], { cwd: join(root, "packages/app"), env: { ...env, PORT: String(APP_PORT), HOST: "127.0.0.1", ORIGIN: DEV_ENV.APP_ORIGIN }, stdout: "inherit", stderr: "inherit" });

// :5173 → /zero/* to zero-cache (HTTP + WebSocket), everything else to the app
const zero = new URL(DEV_ENV.ZERO_CACHE_URL);
type WsData = { upstream: WebSocket; queue: (string | ArrayBuffer | Uint8Array)[] };
Bun.serve<WsData, never>({
  port: 5173,
  hostname: "0.0.0.0",
  async fetch(req, server) {
    const url = new URL(req.url);
    const isZero = url.pathname === "/zero" || url.pathname.startsWith("/zero/");
    if (isZero && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const target = `ws://${zero.host}${url.pathname.slice(5) || "/"}${url.search}`;
      const protocols = req.headers.get("sec-websocket-protocol")?.split(",").map((p) => p.trim());
      // zero-cache authenticates the connection by forwarding the browser's cookie to the app
      const upstream = new WebSocket(target, { protocols, headers: { cookie: req.headers.get("cookie") ?? "", origin: req.headers.get("origin") ?? "" } } as any);
      upstream.binaryType = "arraybuffer";
      const ok = server.upgrade(req, { data: { upstream, queue: [] }, headers: protocols?.length ? { "Sec-WebSocket-Protocol": protocols[0] } : undefined });
      return ok ? undefined : new Response("upgrade failed", { status: 400 });
    }
    const dest = isZero ? `${zero.origin}${url.pathname.slice(5) || "/"}${url.search}` : `http://127.0.0.1:${APP_PORT}${url.pathname}${url.search}`;
    const headers = new Headers(req.headers);
    headers.set("x-forwarded-host", url.host);
    headers.set("x-forwarded-proto", "http");
    return fetch(dest, { method: req.method, headers, body: req.body, redirect: "manual", decompress: false } as RequestInit);
  },
  websocket: {
    open(ws) {
      const { upstream } = ws.data;
      upstream.onopen = () => {
        for (const m of ws.data.queue) upstream.send(m);
        ws.data.queue = [];
      };
      upstream.onmessage = (e) => ws.send(e.data as any);
      upstream.onclose = (e) => ws.close(e.code === 1005 ? 1000 : e.code, e.reason);
      upstream.onerror = () => ws.close(1011);
    },
    message(ws, msg) {
      const { upstream } = ws.data;
      if (upstream.readyState === WebSocket.OPEN) upstream.send(msg);
      else ws.data.queue.push(msg);
    },
    close(ws, code, reason) {
      ws.data.upstream.close(code === 1005 ? 1000 : code, reason);
    },
  },
});
console.log("proxy on http://localhost:5173 (app :5176, /zero → " + zero.origin + ")");
const stop = () => (engine.kill(), pool.kill(), app.kill(), process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.race([engine.exited, pool.exited, app.exited]);
stop();
