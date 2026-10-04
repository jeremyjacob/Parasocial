// Engine pool (§3): runs the same engine build as the browser for MCP calls (write results,
// render, measure, describe…). One Deno process per active document (pinned while active, so
// its per-op cache stays warm); idle documents are recycled. Each process may only read the
// engine build: no network, env, writes or subprocesses. MCP never depends on a browser tab being open.
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEngine, type EngineAssets } from "@parasocial/runtime/server/build";
import { createPool, type HostProc, type JobRequest } from "./pool";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.POOL_PORT ?? 5190);
const MAX_DOCS = Number(process.env.POOL_MAX_DOCS ?? 4);
const IDLE_MS = Number(process.env.POOL_IDLE_MS ?? 10 * 60_000);
const TIMEOUT_MS = Number(process.env.POOL_REGEN_TIMEOUT_MS ?? 10_000);
const DENO = process.env.DENO_BIN ?? "deno";
/** V8 heap cap per host, in MB. OCCT's WASM memory sits outside it; this bounds runaway JS. */
const HEAP_MB = Number(process.env.POOL_HOST_HEAP_MB ?? 512);
/** A host that hasn't answered one request in this long is wedged: killed and replaced. */
const REQUEST_TIMEOUT_MS = Number(process.env.POOL_REQUEST_TIMEOUT_MS ?? Math.max(60_000, TIMEOUT_MS * 3));

let assets: EngineAssets;

async function build() {
  assets = await buildEngine(join(here, "../dist/engine"), { browser: false });
  // the host sits next to the engine build: its read permission covers both
  const res = await Bun.build({ entrypoints: [join(here, "host.ts")], outdir: assets.dir, target: "browser", format: "esm", minify: true, naming: "host.js" });
  if (!res.success) throw new AggregateError(res.logs, "pool host build failed");
}

function spawnHost(): HostProc {
  const config = { assets: { glueSingle: assets.glueSingle, wasmSingle: assets.wasmSingle, build: assets.build }, timeoutMs: TIMEOUT_MS };
  return Bun.spawn(
    [DENO, "run", "--no-prompt", "--no-config", "--no-lock", "--no-remote", "--no-npm", `--allow-read=${assets.dir}`, `--v8-flags=--max-old-space-size=${HEAP_MB}`, join(assets.dir, "host.js"), JSON.stringify(config)],
    // nothing from the server's environment (secrets) reaches the host. MALLOC_ARENA_MAX: glibc otherwise
    // keeps a 64 MB malloc arena per thread (Deno's runtime + lavapipe's), roughly doubling RSS.
    { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", NO_COLOR: "1", DENO_NO_UPDATE_CHECK: "1", MALLOC_ARENA_MAX: process.env.MALLOC_ARENA_MAX ?? "2" } },
  );
}

const pool = createPool({ spawnHost: () => spawnHost(), maxDocs: MAX_DOCS, idleMs: IDLE_MS, requestTimeoutMs: REQUEST_TIMEOUT_MS });
const { runJob, close, slots } = pool;
export type { JobRequest };

if (import.meta.main) {
  if (!Bun.which(DENO)) {
    console.error(`engine pool: Deno not found ("${DENO}"). Install it (https://deno.com) or set DENO_BIN.`);
    process.exit(1);
  }
  // a stray rejection is logged, never fatal: every document's engine would go down with the server
  process.on("unhandledRejection", (e) => console.error("engine pool: unhandled rejection", e));
  await build();
  if (process.env.POOL_WATCH === "1") {
    // dev: rebuild the engine + host when their sources change, and drop stale hosts
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
      if (u.pathname === "/v1/jobs" && req.method === "POST") {
        if (process.env.POOL_TOKEN && req.headers.get("authorization") !== `Bearer ${process.env.POOL_TOKEN}`) return new Response("unauthorized", { status: 401 });
        let job: JobRequest | undefined;
        try {
          job = (await req.json()) as JobRequest;
          return Response.json({ results: await runJob(job) });
        } catch (e) {
          const ops = job?.ops?.map((op) => op.op).join(",") ?? "?";
          console.error(`engine pool: job failed (document ${job?.document?.slice(0, 8) ?? "?"}, ops ${ops})`, e);
          return Response.json({ error: String((e as Error).message ?? e) }, { status: 500 });
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`engine pool on http://${server.hostname}:${server.port} (max ${MAX_DOCS} documents)`);
  const shutdown = async () => {
    await pool.closeAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
