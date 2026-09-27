import "./svelte-plugin.ts";
import { expect, test } from "bun:test";
import type { TypedView } from "@rocicorp/zero";

const { useQuery } = await import("../src/svelte/query.svelte.ts");
// $effect.root / $state are compiler syntax; the test drives the same client runtime directly.
// (Bare `svelte` resolves to the server entry under Bun, so flush comes from the internal client.)
const $ = await import("svelte/internal/client");
const flushSync = () => $.flush();

/** A fake Zero that records every view it hands out and whether it was destroyed. */
function fakeZero() {
  const views: { query: unknown; destroyed: boolean; listeners: Set<(d: any, rt: any) => void>; push(d: any): void }[] = [];
  return {
    views,
    open: () => views.filter((v) => !v.destroyed).length,
    materialize(query: unknown): TypedView<any> {
      const v = {
        query,
        destroyed: false,
        listeners: new Set<(d: any, rt: any) => void>(),
        push(d: any) {
          for (const l of v.listeners) l(d, "complete");
        },
      };
      views.push(v);
      return {
        data: [],
        addListener(l) {
          v.listeners.add(l as never);
          return () => v.listeners.delete(l as never);
        },
        destroy() {
          v.destroyed = true;
          v.listeners.clear();
        },
        updateTTL() {},
      };
    },
  };
}

test("views are destroyed when the owning effect root is disposed (no leaked subscriptions)", () => {
  const zero = fakeZero();
  const disposers: (() => void)[] = [];
  for (let i = 0; i < 50; i++) {
    disposers.push(
      $.effect_root(() => {
        useQuery(() => ({ q: i }), { zero });
      }),
    );
  }
  flushSync();
  expect(zero.open()).toBe(50);
  for (const d of disposers) d();
  flushSync();
  expect(zero.open()).toBe(0);
  expect(zero.views.every((v) => v.listeners.size === 0)).toBe(true);
});

test("changing the query re-subscribes and destroys the previous view", () => {
  const zero = fakeZero();
  const id = $.state(1);
  let result!: ReturnType<typeof useQuery>;
  const dispose = $.effect_root(() => {
    result = useQuery(() => ({ doc: $.get(id) }), { zero });
  });
  flushSync();
  expect(zero.views.length).toBe(1);
  zero.views[0]!.push([{ id: "a" }]);
  expect(result.data).toEqual([{ id: "a" }]);
  expect(result.status).toBe("complete");

  $.set(id, 2);
  flushSync();
  expect(zero.views.length).toBe(2);
  expect(zero.views[0]!.destroyed).toBe(true);
  expect(zero.open()).toBe(1);
  expect(result.data).toEqual([]); // new view's initial data
  expect(result.status).toBe("unknown");

  // A stale push from the old view can't reach the state any more.
  zero.views[0]!.push([{ id: "stale" }]);
  expect(result.data).toEqual([]);

  dispose();
  expect(zero.open()).toBe(0);
});

test("a falsy query subscribes to nothing", () => {
  const zero = fakeZero();
  const on = $.state(false);
  let result!: ReturnType<typeof useQuery>;
  const dispose = $.effect_root(() => {
    result = useQuery(() => $.get(on) && { q: 1 }, { zero });
  });
  flushSync();
  expect(zero.views.length).toBe(0);
  expect(result.data).toBeUndefined();
  $.set(on, true);
  flushSync();
  expect(zero.open()).toBe(1);
  $.set(on, false);
  flushSync();
  expect(zero.open()).toBe(0);
  dispose();
});

test("works against a real (offline, in-memory) Zero client with optimistic mutators", async () => {
  const { Zero } = await import("@rocicorp/zero");
  const { schema } = await import("../src/schema.ts");
  const { mutators } = await import("../src/mutators.ts");
  const { queries } = await import("../src/queries.ts");
  const userID = "u1";
  const zero = new Zero({ schema, userID, cacheURL: null, kvStore: "mem", mutators, context: { userID }, logLevel: "error" });
  let docs!: ReturnType<typeof useQuery>;
  const dispose = $.effect_root(() => {
    docs = useQuery(() => queries.documents.mine(), { zero });
  });
  flushSync();
  expect(docs.data).toEqual([]);

  const r = zero.mutate(mutators.document.create({ id: "d1", name: "Bracket" }));
  expect((await r.client).type).toBe("success");
  flushSync();
  expect((docs.data as { name: string }[]).map((d) => d.name)).toEqual(["Bracket"]);

  // Client-side (optimistic) script write creates a version locally too.
  const w = zero.mutate(mutators.script.write({ documentID: "d1", path: "parts/a.ts", content: "x", baseVersion: null }));
  expect((await w.client).type).toBe("success");
  const vs = await zero.run(queries.versions({ documentID: "d1" }));
  expect(vs.map((v) => v.message)).toEqual(["Create parts/a.ts"]);

  // Client-side path validation rejects before anything is pushed.
  const bad = zero.mutate(mutators.script.write({ documentID: "d1", path: "x.ts", content: "x", baseVersion: null }));
  const res = await bad.client;
  expect(res.type).toBe("error");

  dispose();
  await zero.close();
});
