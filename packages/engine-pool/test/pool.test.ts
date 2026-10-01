// Pool self-healing, against a fake host process (test/fake-host.ts) that crashes, hangs or
// prints noise on demand. The real Deno host's worker-level recovery is covered by
// packages/runtime/test/worker-timeout.test.ts (it runs src/engine.ts with fake workers).
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { createPool, type HostProc } from "../src/pool";

const FAKE = join(import.meta.dir, "fake-host.ts");
let pools: ReturnType<typeof createPool>[] = [];
afterEach(async () => {
  for (const p of pools) await p.closeAll();
  pools = [];
});

function pool(opts: { requestTimeoutMs?: number } = {}) {
  let spawned = 0;
  const logs: string[] = [];
  const p = createPool({
    spawnHost: (): HostProc => {
      spawned++;
      return Bun.spawn(["bun", FAKE], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    },
    requestTimeoutMs: opts.requestTimeoutMs ?? 5000,
    log: (m) => logs.push(m),
  });
  pools.push(p);
  return { p, logs, spawned: () => spawned };
}

const job = (ops: { op: string; [k: string]: unknown }[], scripts: Record<string, string> = { "studios/a.ts": "ok" }) => ({ document: "doc-1", scripts, ops });
const regen = (part: string) => ({ op: "regenerate", part });

test("stdout noise from the kernel is logged, not parsed", async () => {
  const { p, logs } = pool();
  const r = await p.runJob(job([regen("noisy"), regen("a")]));
  expect(r.map((x) => x.ok)).toEqual([true, true]);
  expect(logs.some((l) => l.includes("Transfer Mode"))).toBe(true);
  expect(logs.some((l) => l.includes("Write Done"))).toBe(true);
});

test("a request that crashes the host fails alone; the rest of the job runs on a fresh host", async () => {
  const { p, spawned } = pool();
  const r = await p.runJob(job([regen("a"), regen("crash"), regen("b")]));
  expect(r[0]).toMatchObject({ ok: true });
  expect(r[1]).toMatchObject({ ok: false, crashed: true });
  expect((r[1] as any).error).toContain('exited (code 3) while running regenerate "crash"');
  expect(r[2]).toMatchObject({ ok: true });
  // b ran in a different process than a
  expect((r[2] as any).value.pid).not.toBe((r[0] as any).value.pid);
  expect(spawned()).toBe(2);
  // and the document keeps working on the next job
  const next = await p.runJob(job([regen("c")]));
  expect(next[0]).toMatchObject({ ok: true });
});

test("a host that stops answering is killed and replaced", async () => {
  const { p } = pool({ requestTimeoutMs: 400 });
  const r = await p.runJob(job([regen("hang"), regen("b")]));
  expect(r[0]).toMatchObject({ ok: false, crashed: true });
  expect((r[0] as any).error).toContain('stopped responding (no answer to regenerate "hang"');
  expect(r[1]).toMatchObject({ ok: true });
});

test("repeated crashes in one job stop after a few restarts instead of looping", async () => {
  const { p, spawned } = pool();
  const r = await p.runJob(job([regen("crash"), regen("crash"), regen("crash"), regen("crash"), regen("a")]));
  expect(r.map((x) => x.ok)).toEqual([false, false, false, false, false]);
  expect((r[3] as any).error).toStartWith("skipped:");
  expect(spawned()).toBe(3);
});

test("scripts that crash the host on load fail the job clearly, and a fixed script recovers", async () => {
  const { p } = pool();
  const bad = await p.runJob(job([regen("a"), regen("b")], { "studios/a.ts": "CRASH_ON_LOAD" }));
  expect(bad.map((x) => x.ok)).toEqual([false, false]);
  expect((bad[0] as any).error).toContain("Loading the document's scripts crashed it");
  const good = await p.runJob(job([regen("a")], { "studios/a.ts": "fixed" }));
  expect(good[0]).toMatchObject({ ok: true });
});

test("jobs for one document run one at a time, across host replacements", async () => {
  const { p } = pool();
  const [a, b] = await Promise.all([p.runJob(job([regen("crash")])), p.runJob(job([regen("x")]))]);
  expect(a[0].ok).toBe(false);
  expect(b[0]).toMatchObject({ ok: true });
});
