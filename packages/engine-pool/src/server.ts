// Engine pool (§3): runs the same engine build as the browser for MCP calls (write results,
// render, measure, describe…). One Deno process per active document (pinned while active, so
// its per-op cache stays warm); idle documents are recycled. Each process may only read the
// engine build: no network, env, writes or subprocesses. MCP never depends on a browser tab being open.
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Subprocess } from "bun";
import { buildEngine, type EngineAssets } from "@parasocial/runtime/server/build";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.POOL_PORT ?? 5190);
const MAX_DOCS = Number(process.env.POOL_MAX_DOCS ?? 4);
const IDLE_MS = Number(process.env.POOL_IDLE_MS ?? 10 * 60_000);
const TIMEOUT_MS = Number(process.env.POOL_REGEN_TIMEOUT_MS ?? 10_000);
const DENO = process.env.DENO_BIN ?? "deno";

type Slot = { proc: Subprocess<"pipe", "pipe", "inherit">; send: (m: { req?: unknown; render?: unknown }) => Promise<any>; lastUsed: number; busy: Promise<unknown>; scripts: Map<string, string>; overrides: string; units: string };
const slots = new Map<string, Slot>();

let assets: EngineAssets;

async function build() {
  assets = await buildEngine(join(here, "../dist/engine"));
  // the host sits next to the engine build: its read permission covers both
  const res = await Bun.build({ entrypoints: [join(here, "host.ts")], outdir: assets.dir, target: "browser", format: "esm", minify: true, naming: "host.js" });
  if (!res.success) throw new AggregateError(res.logs, "pool host build failed");
}

async function open(documentID: string): Promise<Slot> {
  // evict idle / least recently used documents
  for (const [id, s] of slots) if (Date.now() - s.lastUsed > IDLE_MS) await close(id);
  if (slots.size >= MAX_DOCS) {
    const lru = [...slots].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    if (lru) await close(lru[0]);
  }
  const config = { assets: { glueSingle: assets.glueSingle, wasmSingle: assets.wasmSingle, build: assets.build }, timeoutMs: TIMEOUT_MS };
  const proc = Bun.spawn(
    [DENO, "run", "--no-prompt", "--no-config", "--no-lock", "--no-remote", "--no-npm", `--allow-read=${assets.dir}`, "--v8-flags=--max-old-space-size=2048", join(assets.dir, "host.js"), JSON.stringify(config)],
    // nothing from the server's environment (secrets) reaches the host
    { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", NO_COLOR: "1", DENO_NO_UPDATE_CHECK: "1" } },
  );
  const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  let started!: (v: unknown) => void, failed!: (e: Error) => void;
  const ready = new Promise((res, rej) => ((started = res), (failed = rej)));
  (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const m = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if ("ready" in m) started(m.ready);
        else if ("fatal" in m) failed(new Error(`engine host: ${m.fatal}`));
        else {
          const { id, ...result } = m;
          waiting.get(id)?.resolve(result);
          waiting.delete(id);
        }
      }
    }
  })().finally(() => {
    const e = new Error(`engine host for ${documentID.slice(0, 8)} exited`);
    failed(e);
    for (const w of waiting.values()) w.reject(e);
    waiting.clear();
    if (slots.get(documentID) === slot) slots.delete(documentID);
  });
  const send = (m: { req?: unknown; render?: unknown }) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ id, ...m }) + "\n");
      proc.stdin.flush();
    });
  const slot: Slot = { proc, send, lastUsed: Date.now(), busy: Promise.resolve(), scripts: new Map(), overrides: "", units: "" };
  slots.set(documentID, slot);
  try {
    await ready;
  } catch (e) {
    await close(documentID);
    throw e;
  }
  return slot;
}

async function close(id: string) {
  const s = slots.get(id);
  slots.delete(id);
  if (!s) return;
  s.proc.kill();
  await s.proc.exited.catch(() => {});
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
    const rpc = (req: unknown) => slot.send({ req });
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
      if (op.op === "render") results.push(await slot.send({ render: op }));
      else results.push(await rpc(op));
    }
    return results;
  });
  slot.busy = run.catch(() => {});
  try {
    return await run;
  } catch (e) {
    // the host died: drop it; the next job starts fresh
    await close(job.document);
    throw e;
  }
}

if (import.meta.main) {
  if (!Bun.which(DENO)) {
    console.error(`engine pool: Deno not found ("${DENO}"). Install it (https://deno.com) or set DENO_BIN.`);
    process.exit(1);
  }
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
