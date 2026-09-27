import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { LatestWins } from "../src/scheduler";

const transpiler = new Bun.Transpiler({ loader: "ts" });
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const info = { threads: 1, crossOriginIsolated: true, kernelMs: 0, build: "test" };

/** Run the actual host scripts with a deterministic clock and controllable worker messages. */
async function host(kind: "browser" | "pool") {
  let now = 0;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const workers: FakeWorker[] = [];
  const replies: any[] = [];
  class FakeWorker {
    onmessage?: (event: any) => void;
    listeners = new Set<(event: any) => void>();
    sent: any[] = [];
    terminated = false;
    constructor() { workers.push(this); }
    addEventListener(type: string, fn: (event: any) => void) { if (type === "message") this.listeners.add(fn); }
    removeEventListener(_type: string, fn: (event: any) => void) { this.listeners.delete(fn); }
    postMessage(message: any) { this.sent.push(message); }
    emit(message: any) {
      for (const fn of this.listeners) fn({ data: message });
      this.onmessage?.({ data: message });
    }
    terminate() { this.terminated = true; }
  }
  class FakePort {
    onmessage?: (event: any) => void;
    postMessage(message: any) { if (message.type === "result") replies.push(message); }
  }
  const port = new FakePort();
  let connect: (event: any) => Promise<void>;
  const config = { assets: info, timeoutMs: 100, allowedParents: ["https://app.test"] };
  const context: any = {
    ENGINE_CONFIG: config, POOL: config,
    Worker: FakeWorker, MessagePort: FakePort, URL, URLSearchParams,
    location: { href: "https://engine.test/", search: "" }, navigator: {},
    window: { parent: { postMessage() {} }, addEventListener(_type: string, fn: typeof connect) { connect = fn; } },
    setTimeout(fn: () => void, delay: number) {
      const id = nextTimer++;
      timers.set(id, { at: now + delay, fn });
      return id;
    },
    clearTimeout(id: number) { timers.delete(id); },
  };
  const path = kind === "browser" ? "../src/browser/page.ts" : "../../engine-pool/src/page.ts";
  // Rendering is not exercised; no DOM/WebGL is needed for the pool's RPC lifecycle.
  const source = readFileSync(new URL(path, import.meta.url), "utf8").replace(/^import .* from "@parasocial\/viewer";\n/m, "");
  runInNewContext(transpiler.transformSync(source), context);
  workers[0].emit({ type: "ready", info });
  await flush();
  if (kind === "browser") await connect!({ origin: "https://app.test", data: { type: "connect" }, ports: [port] });
  // The browser's warm spare is ready before a timeout occurs.
  workers[1]?.emit({ type: "ready", info });
  let nextRequest = 1;
  return {
    workers, replies,
    async request(req: any) {
      const id = nextRequest++;
      if (kind === "browser") port.onmessage!({ data: { id, req } });
      else context.rpc(req).then((r: any) => replies.push({ id, ...r }));
      await flush();
      return id;
    },
    async tick(ms: number) {
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

for (const kind of ["browser", "pool"] as const) {
  test(`${kind}: queued regeneration gets its full budget after earlier parts finish`, async () => {
    const h = await host(kind);
    const ids = [];
    for (const part of ["a", "b", "c"]) ids.push(await h.request({ op: "regenerate", part }));
    // Loading/queueing alone must never arm the watchdog.
    await h.tick(200);
    expect(h.workers[0].terminated).toBe(false);
    for (const id of ids) {
      h.workers[0].emit({ type: "started", id });
      await h.tick(80);
      h.workers[0].emit({ type: "result", id, ok: true, value: { part: "test" } });
      await flush();
    }
    await h.tick(200);
    expect(h.workers[0].terminated).toBe(false);
    expect(h.replies.map((r) => r.ok)).toEqual([true, true, true]);
  });

  for (const op of ["regenerate", "regenerateSnapshot"]) {
    test(`${kind}: ${op} still times out and recovers with document state`, async () => {
      const h = await host(kind);
      const doc = { op: "setDocument", doc: { scripts: {} } };
      const setId = await h.request(doc);
      h.workers[0].emit({ type: "result", id: setId, ok: true, value: [] });
      await flush();
      const id = await h.request({ op, part: "slow", key: "v1", doc: doc.doc });
      const queuedId = await h.request({ op: "regenerate", part: "queued" });
      h.workers[0].emit({ type: "started", id });
      await h.tick(60);
      // A duplicate notification must not extend the budget.
      h.workers[0].emit({ type: "started", id });
      await h.tick(40);
      expect(h.workers[0].terminated).toBe(true);
      expect(h.replies.filter((r) => r.timeout).map((r) => r.id)).toEqual([id, queuedId]);
      expect(h.workers[1].sent.some((m) => m.req?.op === "setDocument")).toBe(true);
      h.workers[1].emit({ type: "ready", info });
      const recoveredId = await h.request({ op: "regenerate", part: "recovered" });
      // A delayed notification from the old worker cannot arm a timer in its replacement.
      h.workers[0].emit({ type: "started", id: recoveredId });
      await h.tick(200);
      expect(h.workers[1].terminated).toBe(false);
      h.workers[1].emit({ type: "started", id: recoveredId });
      await h.tick(80);
      h.workers[1].emit({ type: "result", id: recoveredId, ok: true, value: {} });
      await h.tick(200);
      expect(h.replies.at(-1)).toMatchObject({ id: recoveredId, ok: true });
      expect(h.workers[1].terminated).toBe(false);
    });
  }

  test(`${kind}: failed and superseded requests leave no watchdog behind`, async () => {
    const h = await host(kind);
    const first = await h.request({ op: "regenerate", part: "a" });
    h.workers[0].emit({ type: "started", id: first });
    h.workers[0].emit({ type: "result", id: first, ok: false, error: "bad geometry" });
    const second = await h.request({ op: "regenerate", part: "a" });
    h.workers[0].emit({ type: "result", id: second, ok: true, value: null });
    await h.tick(200);
    expect(h.workers[0].terminated).toBe(false);
    expect(h.replies.map((r) => r.ok)).toEqual([false, true]);
  });
}

test("worker announces execution before running live or snapshot geometry, including failures", async () => {
  const events: any[] = [];
  class Engine {
    setDocument() {}
    regenerate(part: string) {
      events.push({ type: "compute", part });
      if (part === "bad") throw new Error("bad geometry");
      return { part };
    }
  }
  const self: any = { postMessage: (m: any) => events.push(m) };
  const source = readFileSync(new URL("../src/browser/worker.ts", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
  runInNewContext(transpiler.transformSync(source), { self, Engine, LatestWins });
  for (const [id, op, part] of [[1, "regenerate", "a"], [2, "regenerateSnapshot", "b"], [3, "regenerate", "bad"]] as const) {
    await self.onmessage({ data: { id, req: { op, part, key: "snapshot", doc: {} } } });
    await flush();
    expect(events.splice(0)).toMatchObject([
      { type: "started", id }, { type: "compute", part }, { type: "result", id },
    ]);
  }
});
