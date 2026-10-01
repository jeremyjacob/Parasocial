import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { LatestWins } from "../src/scheduler";
import { sourcePart } from "../src/protocol";

const transpiler = new Bun.Transpiler({ loader: "ts" });
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const info = { threads: 1, crossOriginIsolated: true, kernelMs: 0, build: "test" };

/** Run the actual host scripts with a deterministic clock and controllable worker messages. */
async function host(kind: "browser" | "pool", search = "") {
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
    onerror?: (event: any) => void;
    errorListeners = new Set<(event: any) => void>();
    addEventListener(type: string, fn: (event: any) => void) { if (type === "message") this.listeners.add(fn); else if (type === "error") this.errorListeners.add(fn); }
    removeEventListener(_type: string, fn: (event: any) => void) { this.listeners.delete(fn); this.errorListeners.delete(fn); }
    /** An uncaught error in the worker (it's dead afterwards). */
    crash(message: string) {
      const ev = { message, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      for (const fn of this.errorListeners) fn(ev);
      this.onerror?.(ev);
      return ev;
    }
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
    Worker: FakeWorker, MessagePort: FakePort, URL, URLSearchParams, sourcePart,
    location: { href: "https://engine.test/", search }, navigator: {},
    window: { parent: { postMessage() {} }, addEventListener(_type: string, fn: typeof connect) { connect = fn; } },
    setTimeout(fn: () => void, delay: number) {
      const id = nextTimer++;
      timers.set(id, { at: now + delay, fn });
      return id;
    },
    clearTimeout(id: number) { timers.delete(id); },
  };
  const path = kind === "browser" ? "../src/browser/page.ts" : "../../engine-pool/src/engine.ts";
  const source = readFileSync(new URL(path, import.meta.url), "utf8").replace(/^import .* from "(@parasocial\/viewer|\.\.\/protocol)";\n/gm, "");
  runInNewContext(transpiler.transformSync(source), context);
  const count = workers.length;
  for (const w of workers) w.emit({ type: "ready", info });
  await flush();
  if (kind === "browser") await connect!({ origin: "https://app.test", data: { type: "connect" }, ports: [port] });
  // The browser's warm spare is ready before a timeout occurs.
  workers[count]?.emit({ type: "ready", info });
  let nextRequest = 1;
  return {
    workers, replies, count,
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
      // The browser gives a part that was still waiting for a worker to the replacement instead of failing it.
      const waited = kind === "browser" && op === "regenerate";
      expect(h.replies.filter((r) => r.timeout).map((r) => r.id)).toEqual(waited ? [id] : [id, queuedId]);
      if (waited) expect(h.workers[1].sent.some((m) => m.id === queuedId)).toBe(true);
      expect(h.workers[1].sent.some((m) => m.req?.op === "setDocument")).toBe(true);
      h.workers[1].emit({ type: "ready", info });
      if (waited) h.workers[1].emit({ type: "result", id: queuedId, ok: true, value: {} });
      await flush();
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
  runInNewContext(transpiler.transformSync(source), { self, Engine, LatestWins, kernelFault: () => null, noteKernelFault: () => false });
  for (const [id, op, part] of [[1, "regenerate", "a"], [2, "regenerateSnapshot", "b"], [3, "regenerate", "bad"]] as const) {
    await self.onmessage({ data: { id, req: { op, part, key: "snapshot", doc: {} } } });
    await flush();
    expect(events.splice(0)).toMatchObject([
      { type: "started", id }, { type: "compute", part }, { type: "result", id },
    ]);
  }
});

describe("browser: parts regenerate on several workers", () => {
  const sentTo = (w: any, op: string) => w.sent.filter((m: any) => m.req?.op === op);
  const answer = async (h: any, w: any, id: number, value: unknown) => {
    w.emit({ type: "result", id, ok: true, value });
    await flush();
  };

  test("each part goes to the first idle worker and stays there; instances follow their source part", async () => {
    const h = await host("browser", "?workers=3");
    expect(h.count).toBe(3);
    const [a, b, c, d] = [await h.request({ op: "regenerate", part: "a" }), await h.request({ op: "regenerate", part: "b" }), await h.request({ op: "regenerate", part: "c" }), await h.request({ op: "regenerate", part: "d" })];
    expect(h.workers.slice(0, 3).map((w: any) => sentTo(w, "regenerate").map((m: any) => m.req.part))).toEqual([["a"], ["b"], ["c"]]);
    // d waits for whichever worker finishes first
    await answer(h, h.workers[1], b, { part: "b", key: "kb" });
    expect(sentTo(h.workers[1], "regenerate").map((m: any) => m.id)).toEqual([b, d]);
    await h.request({ op: "describe", part: "c", kind: "face", index: 0 });
    await h.request({ op: "regenerate", part: "asm/c@left" });
    expect(h.workers[2].sent.filter((m: any) => m.req).map((m: any) => m.req.op)).toEqual(["regenerate", "describe", "regenerate"]);
    expect(h.replies.map((r: any) => r.id)).toEqual([b]);
    void a; void c;
  });

  test("document state reaches every worker; the app gets one answer", async () => {
    const h = await host("browser", "?workers=3");
    const id = await h.request({ op: "setScript", path: "studios/a.ts", content: "x" });
    for (const w of h.workers.slice(0, 3)) expect(sentTo(w, "setScript").length).toBe(1);
    for (const w of h.workers.slice(0, 3)) await answer(h, w, w.sent.at(-1).id, []);
    expect(h.replies.map((r: any) => r.id)).toEqual([id]);
  });

  test("affected: a part is affected only if every worker says so", async () => {
    const h = await host("browser", "?workers=2");
    const id = await h.request({ op: "affected", paths: ["lib/x.ts"] });
    await answer(h, h.workers[0], sentTo(h.workers[0], "affected")[0].id, ["a", "b", "c"]);
    expect(h.replies).toEqual([]);
    await answer(h, h.workers[1], sentTo(h.workers[1], "affected")[0].id, ["a", "c", "d"]);
    expect(h.replies).toMatchObject([{ id, ok: true, value: ["a", "c"] }]);
  });

  test("cross-part requests run on worker 0 with the other workers' shapes, fetched again only when they change", async () => {
    const h = await host("browser", "?workers=2");
    const a = await h.request({ op: "regenerate", part: "a" });
    const b = await h.request({ op: "regenerate", part: "b" });
    await answer(h, h.workers[0], a, { part: "a", key: "ka" });
    await answer(h, h.workers[1], b, { part: "b", key: "kb1" });
    const measure = async () => {
      const id = await h.request({ op: "measure", a: { part: "a", kind: "part" }, b: { part: "b", kind: "part" } });
      const ask = sentTo(h.workers[1], "shapeOf").at(-1);
      return { id, ask };
    };
    const m1 = await measure();
    expect(m1.ask.req.part).toBe("b");
    expect(sentTo(h.workers[0], "measure")).toEqual([]);
    await answer(h, h.workers[1], m1.ask.id, { key: "kb1", brep: "B1" });
    expect(h.workers[0].sent.slice(-2).map((m: any) => m.req.op)).toEqual(["adopt", "measure"]);
    expect(sentTo(h.workers[0], "adopt")[0].req).toMatchObject({ part: "b", key: "kb1", brep: "B1" });
    // unchanged: no second fetch
    await measure();
    expect(sentTo(h.workers[1], "shapeOf").length).toBe(1);
    expect(sentTo(h.workers[0], "measure").length).toBe(2);
    // b regenerated to new geometry: fetched again
    const b2 = await h.request({ op: "regenerate", part: "b" });
    await answer(h, h.workers[1], b2, { part: "b", key: "kb2" });
    await measure();
    expect(sentTo(h.workers[1], "shapeOf").length).toBe(2);
  });
});

describe("self-healing", () => {
  for (const kind of ["browser", "pool"] as const) {
    const answer = async (w: any, id: number, value: unknown = []) => {
      w.emit({ type: "result", id, ok: true, value });
      await flush();
    };
    const lastId = (w: any, op: string) => w.sent.filter((m: any) => m.req?.op === op).at(-1).id;

    test(`${kind}: a crashed worker fails its requests clearly; the replacement gets the state without running scripts`, async () => {
      const h = await host(kind);
      await answer(h.workers[0], await h.request({ op: "setDocument", doc: { scripts: { "studios/a.ts": "v1", "studios/b.ts": "b" } } }));
      await answer(h.workers[0], await h.request({ op: "setScript", path: "studios/a.ts", content: "v2" }));
      await answer(h.workers[0], await h.request({ op: "setScript", path: "studios/b.ts", content: null }));
      await answer(h.workers[0], await h.request({ op: "setOverrides", part: "a", overrides: { w: 3 } }), true);
      const id = await h.request({ op: "regenerate", part: "a" });
      const ev = h.workers[0].crash("RuntimeError: unreachable");
      await flush();
      // handled: it never reaches (and kills) the host
      expect(ev.defaultPrevented).toBe(true);
      expect(h.workers[0].terminated).toBe(true);
      const failed = h.replies.find((r) => r.id === id);
      expect(failed).toMatchObject({ ok: false });
      expect(failed.error).toContain("crashed");
      // one quiet setDocument with the latest scripts and overrides
      expect(h.workers[1].sent.filter((m: any) => m.req).map((m: any) => m.req)).toEqual([{ op: "setDocument", doc: { scripts: { "studios/a.ts": "v2" }, overrides: { a: { w: 3 } } }, quiet: true }]);
      h.workers[1].emit({ type: "ready", info });
      await flush();
      const next = await h.request({ op: "regenerate", part: "a" });
      await answer(h.workers[1], lastId(h.workers[1], "regenerate"), { part: "a" });
      expect(h.replies.at(-1)).toMatchObject({ id: next, ok: true });
    });

    test(`${kind}: after a kernel fault, the request that hit it keeps its answer and the others go to the replacement`, async () => {
      const h = await host(kind);
      const bad = await h.request({ op: "regenerate", part: "a" });
      const other = await h.request({ op: "describe", part: "a", kind: "face", index: 0 });
      h.workers[0].emit({ type: "result", id: lastId(h.workers[0], "regenerate"), ok: true, value: { part: "a", ok: false } });
      h.workers[0].emit({ type: "poisoned", error: "Out of bounds memory access" });
      await flush();
      expect(h.workers[0].terminated).toBe(true);
      expect(h.replies.map((r) => [r.id, r.ok])).toEqual([[bad, true]]);
      const resent = h.workers[1].sent.find((m: any) => m.req?.op === "describe");
      expect(resent).toBeDefined();
      h.workers[1].emit({ type: "ready", info });
      await answer(h.workers[1], resent.id, { name: "face" });
      expect(h.replies.at(-1)).toMatchObject({ id: other, ok: true, value: { name: "face" } });
    });

    test(`${kind}: a script looping at its top level times out while loading`, async () => {
      const h = await host(kind);
      const id = await h.request({ op: "setScript", path: "studios/a.ts", content: "while (true) {}" });
      h.workers[0].emit({ type: "started", id: lastId(h.workers[0], "setScript") });
      await h.tick(100);
      expect(h.workers[0].terminated).toBe(true);
      const r = h.replies.find((x) => x.id === id);
      expect(r).toMatchObject({ ok: false, timeout: true });
      expect(r.error).toContain("loading the scripts timed out");
      // the replacement only restores it: the loop doesn't run again until something asks
      expect(h.workers[1].sent.filter((m: any) => m.req).map((m: any) => m.req.quiet)).toEqual([true]);
    });

    test(`${kind}: repeated crashes back off before starting another worker`, async () => {
      const h = await host(kind);
      h.workers[0].crash("boom");
      await flush();
      h.workers[1].crash("boom again");
      await flush();
      const before = h.workers.length;
      await h.tick(100);
      expect(h.workers.length).toBe(before);
      await h.tick(200);
      expect(h.workers.length).toBe(before + 1);
    });
  }
});

test("worker: a kernel fault is reported after the answer, and the worker answers nothing more", async () => {
  const events: any[] = [];
  let fault: string | null = null;
  class Engine {
    setDocument() {}
    regenerate(part: string) {
      if (part === "bad") fault = "Out of bounds memory access";
      return { part };
    }
  }
  const self: any = { postMessage: (m: any) => events.push(m) };
  const source = readFileSync(new URL("../src/browser/worker.ts", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
  runInNewContext(transpiler.transformSync(source), { self, Engine, LatestWins, kernelFault: () => fault, noteKernelFault: () => false });
  await self.onmessage({ data: { id: 1, req: { op: "regenerate", part: "bad" } } });
  await flush();
  expect(events.map((e) => e.type)).toEqual(["started", "result", "poisoned"]);
  expect(events[2].error).toBe("Out of bounds memory access");
  await self.onmessage({ data: { id: 2, req: { op: "regenerate", part: "a" } } });
  await flush();
  expect(events.length).toBe(3);
});
