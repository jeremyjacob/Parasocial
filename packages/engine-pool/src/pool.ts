// The pool's host management (§3), separate from the HTTP server so tests can drive it with a fake
// host. One host process per active document, pinned while active (its per-op cache stays warm);
// idle documents are recycled.
//
// Self-healing: a host that exits, stops answering (no reply within `requestTimeoutMs`) or writes
// garbage is dropped; the request it was running gets a clear error, the job's remaining requests
// continue on a fresh host (one crashing part doesn't take its siblings down), and the next job
// starts one anyway. Hosts that keep crashing for a document come back after a short backoff.

/** Prefix of every protocol line the host writes; anything else on its stdout (OCCT, Emscripten) is log noise. */
export const LINE_PREFIX = "@@ps ";

export type HostProc = {
  stdin: { write(chunk: string): unknown; flush?(): unknown };
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number | null>;
  kill(): void;
};

export type PoolOptions = {
  spawnHost: () => HostProc;
  maxDocs?: number;
  idleMs?: number;
  /** A host that hasn't answered a request in this long is killed (it's wedged, not just slow: the engine has its own regeneration timeout). */
  requestTimeoutMs: number;
  /** Most host restarts within one job before its remaining requests are skipped. */
  maxRestartsPerJob?: number;
  log?: (message: string) => void;
};

export type JobRequest = {
  document: string;
  scripts: Record<string, string>;
  overrides?: Record<string, Record<string, string | number>>;
  units?: string;
  ops: ({ op: string; [k: string]: unknown } | { op: "render"; [k: string]: unknown })[];
};

export type OpResult = { ok: true; value: unknown } | { ok: false; error: string; timeout?: boolean; crashed?: boolean };

/** The host died (or was killed) while a request was outstanding. */
export class HostDied extends Error {}

type Slot = {
  proc: HostProc;
  send: (m: { req?: unknown; render?: unknown }, label: string) => Promise<any>;
  lastUsed: number;
  scripts: Map<string, string>;
  overrides: string;
  units: string;
  /** why the host is gone (null while alive) */
  dead: string | null;
};

const CRASH_WINDOW_MS = 60_000;

export function createPool(o: PoolOptions) {
  const maxDocs = o.maxDocs ?? 4;
  const idleMs = o.idleMs ?? 10 * 60_000;
  const maxRestarts = o.maxRestartsPerJob ?? 2;
  const log = o.log ?? ((m: string) => console.error(m));
  const slots = new Map<string, Slot>();
  /** jobs per document run one at a time, across host replacements */
  const queues = new Map<string, Promise<unknown>>();
  /** recent crash times per document (backoff) */
  const crashes = new Map<string, number[]>();

  function recentCrashes(doc: string) {
    const now = Date.now();
    const list = (crashes.get(doc) ?? []).filter((t) => now - t < CRASH_WINDOW_MS);
    crashes.set(doc, list);
    return list;
  }

  async function open(doc: string): Promise<Slot> {
    // evict idle / least recently used documents
    for (const [id, s] of slots) if (Date.now() - s.lastUsed > idleMs) await close(id);
    if (slots.size >= maxDocs) {
      const lru = [...slots].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (lru) await close(lru[0]);
    }
    // a host that keeps crashing comes back after a short wait (250 ms, 500 ms… 4 s)
    const n = recentCrashes(doc).length;
    if (n >= 2) await new Promise((r) => setTimeout(r, Math.min(4000, 250 * 2 ** (n - 2))));

    const proc = o.spawnHost();
    const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; label: string }>();
    let nextId = 1;
    let started!: (v: unknown) => void, failed!: (e: Error) => void;
    const ready = new Promise((res, rej) => ((started = res), (failed = rej)));
    ready.catch(() => {});

    const die = (reason: string, crash: boolean) => {
      if (slot.dead) return;
      slot.dead = reason;
      if (crash) recentCrashes(doc).push(Date.now());
      if (slots.get(doc) === slot) slots.delete(doc);
      failed(new HostDied(`the geometry engine ${reason}`));
      for (const w of waiting.values()) {
        clearTimeout(w.timer);
        w.reject(new HostDied(`the geometry engine ${reason} while running ${w.label}; it restarts on the next request`));
      }
      waiting.clear();
      try {
        proc.kill();
      } catch {}
    };

    const onLine = (line: string) => {
      if (!line.startsWith(LINE_PREFIX)) {
        if (line.trim()) log(`[engine ${doc.slice(0, 8)}] ${line}`);
        return;
      }
      let m: any;
      try {
        m = JSON.parse(line.slice(LINE_PREFIX.length));
      } catch {
        return log(`[engine ${doc.slice(0, 8)}] unreadable message: ${line.slice(0, 200)}`);
      }
      if ("ready" in m) started(m.ready);
      else if ("fatal" in m) failed(new Error(`engine host: ${m.fatal}`));
      else {
        const { id, ...result } = m;
        const w = waiting.get(id);
        if (!w) return;
        clearTimeout(w.timer);
        waiting.delete(id);
        w.resolve(result);
      }
    };

    (async () => {
      const dec = new TextDecoder();
      let buf = "";
      const reader = proc.stdout.getReader();
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        buf += dec.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          onLine(line);
        }
      }
    })()
      .catch((e) => log(`[engine ${doc.slice(0, 8)}] output: ${e?.message ?? e}`))
      .finally(async () => {
        if (slot.dead) return;
        const code = await Promise.race([proc.exited.catch(() => null), new Promise((r) => setTimeout(() => r(undefined), 1000))]);
        die(code === undefined ? "closed its output" : `exited${code === null ? "" : ` (code ${code})`}`, true);
      });

    const send = (m: { req?: unknown; render?: unknown }, label: string) =>
      new Promise<any>((resolve, reject) => {
        if (slot.dead) return reject(new HostDied(`the geometry engine ${slot.dead}`));
        const id = nextId++;
        const timer = setTimeout(() => die(`stopped responding (no answer to ${label} in ${Math.round(o.requestTimeoutMs / 1000)} s) and was restarted`, true), o.requestTimeoutMs);
        waiting.set(id, { resolve, reject, timer, label });
        try {
          proc.stdin.write(JSON.stringify({ id, ...m }) + "\n");
          proc.stdin.flush?.();
        } catch (e: any) {
          die(`couldn't be reached (${e?.message ?? e})`, true);
        }
      });

    const slot: Slot = { proc, send, lastUsed: Date.now(), scripts: new Map(), overrides: "", units: "", dead: null };
    slots.set(doc, slot);
    const startTimer = setTimeout(() => die(`didn't start within ${Math.round(o.requestTimeoutMs / 1000)} s`, true), o.requestTimeoutMs);
    try {
      await ready;
    } catch (e) {
      die("failed to start", true);
      throw e;
    } finally {
      clearTimeout(startTimer);
    }
    return slot;
  }

  async function close(id: string) {
    const s = slots.get(id);
    slots.delete(id);
    if (!s) return;
    s.dead ??= "was closed";
    s.proc.kill();
    await s.proc.exited.catch(() => {});
  }

  /** Bring the host's document in line with the job (incrementally, so the per-op cache survives). */
  async function sync(slot: Slot, job: JobRequest) {
    const rpc = (req: { op: string; [k: string]: unknown }, label: string) => slot.send({ req }, label);
    const overrides = JSON.stringify(job.overrides ?? {});
    const units = job.units ?? "mm";
    if (slot.units !== units || slot.scripts.size === 0) {
      await rpc({ op: "setDocument", doc: { scripts: job.scripts, overrides: job.overrides ?? {}, units: { length: units, angle: "deg" } } }, "loading the scripts");
      slot.scripts = new Map(Object.entries(job.scripts));
      slot.overrides = overrides;
      slot.units = units;
      return;
    }
    // Discover once after the complete edit, instead of evaluating every studio after
    // each file in a multi-file write (including half-applied imports).
    for (const [p, c] of Object.entries(job.scripts)) if (slot.scripts.get(p) !== c) (await rpc({ op: "setScript", path: p, content: c, quiet: true }, `loading ${p}`), slot.scripts.set(p, c));
    for (const p of [...slot.scripts.keys()]) if (!(p in job.scripts)) (await rpc({ op: "setScript", path: p, content: null, quiet: true }, `removing ${p}`), slot.scripts.delete(p));
    if (slot.overrides !== overrides) {
      const ov = job.overrides ?? {};
      const prev = JSON.parse(slot.overrides || "{}");
      for (const part of new Set([...Object.keys(ov), ...Object.keys(prev)])) if (JSON.stringify(ov[part] ?? {}) !== JSON.stringify(prev[part] ?? {})) await rpc({ op: "setOverrides", part, overrides: ov[part] ?? {} }, "setting params");
      slot.overrides = overrides;
    }
  }

  const labelOf = (op: { op: string; [k: string]: unknown }) => (typeof op.part === "string" ? `${op.op} "${op.part}"` : op.op);

  async function execute(job: JobRequest): Promise<OpResult[]> {
    const results: OpResult[] = [];
    let restarts = 0;
    while (results.length < job.ops.length) {
      const live = slots.get(job.document);
      const slot = live && !live.dead ? live : await open(job.document);
      slot.lastUsed = Date.now();
      let i = results.length;
      try {
        try {
          await sync(slot, job);
        } catch (e) {
          if (!(e instanceof HostDied)) throw e;
          // loading the scripts takes the engine down: nothing in this job can run
          const error = `${e.message}. Loading the document's scripts crashed it, so nothing ran; check the scripts' top-level code`;
          while (results.length < job.ops.length) results.push({ ok: false, error, crashed: true });
          break;
        }
        for (; i < job.ops.length; i++) {
          const op = job.ops[i];
          results.push(op.op === "render" ? await slot.send({ render: op }, "render") : await slot.send({ req: op }, labelOf(op)));
        }
      } catch (e) {
        if (!(e instanceof HostDied)) throw e;
        // this request crashed the host: it fails; the rest go on in a fresh one
        results.push({ ok: false, error: e.message, crashed: true });
        if (++restarts > maxRestarts) {
          while (results.length < job.ops.length) results.push({ ok: false, error: `skipped: the geometry engine crashed ${restarts} times during this request batch`, crashed: true });
        }
      }
    }
    return results;
  }

  /** Run a job's ops in order on the document's host; one result per op. Throws only if no host can start. */
  function runJob(job: JobRequest): Promise<OpResult[]> {
    const prev = queues.get(job.document) ?? Promise.resolve();
    const run = prev.then(() => execute(job));
    // idle time counts from the end of the last job, so a long job isn't already "idle" when it finishes
    const tail = run.catch(() => {}).then(() => {
      const s = slots.get(job.document);
      if (s) s.lastUsed = Date.now();
    });
    queues.set(job.document, tail);
    tail.then(() => queues.get(job.document) === tail && queues.delete(job.document));
    return run;
  }

  // Idle hosts are closed on a timer, not only when another document needs a slot: the last
  // document's host (often ~1 GB) would otherwise stay resident until the next document opens.
  const sweep = setInterval(() => {
    for (const [id, s] of slots) if (!queues.has(id) && Date.now() - s.lastUsed > idleMs) close(id).catch(() => {});
  }, Math.max(1000, Math.min(30_000, idleMs / 4)));
  (sweep as any).unref?.();

  async function closeAll() {
    clearInterval(sweep);
    for (const id of [...slots.keys()]) await close(id);
  }

  return { runJob, close, closeAll, slots };
}
