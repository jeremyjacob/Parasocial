/**
 * Opt-in end-to-end test against a real zero-cache (the compose stack).
 * Skipped unless ZERO_E2E_CACHE_URL is set. See README "Verifying the stack".
 *
 *   ZERO_E2E_CACHE_URL=http://localhost:54848 \
 *   ZERO_E2E_DB=postgres://parasocial:…@localhost:55432/parasocial \
 *   ZERO_E2E_API_KEY=… ZERO_E2E_PORT=53000 bun test test/zero-cache.e2e.test.ts
 *
 * zero-cache must be configured with ZERO_{MUTATE,QUERY}_URL pointing at
 * http://host.docker.internal:$ZERO_E2E_PORT/api/zero/{mutate,query}. This
 * test serves those endpoints from the host with the real handlers, then
 * drives two real Zero clients through zero-cache.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createZero, type ParasocialZero } from "../src/client.ts";
import { mutators } from "../src/mutators.ts";
import { queries } from "../src/queries.ts";
import { createDb, type Db } from "../src/server/db.ts";
import { createMutateHandler, createQueryHandler } from "../src/server/zero.ts";

const cacheURL = process.env.ZERO_E2E_CACHE_URL;
const enabled = !!cacheURL;

let db: Db;
let server: ReturnType<typeof Bun.serve> | undefined;
const tokens = new Map<string, string>(); // bearer token -> userID (test-only auth)
const clients: ParasocialZero[] = [];

async function user(name: string) {
  const id = crypto.randomUUID();
  await db.sql`INSERT INTO users (id, name, avatar_seed) VALUES (${id}, ${name}, ${id})`;
  const token = crypto.randomUUID();
  tokens.set(token, id);
  const z = createZero({ userID: id, cacheURL: cacheURL!, kvStore: "mem", auth: token, logLevel: "error" });
  clients.push(z);
  return { id, z };
}

/** Resolves when `pred(data)` holds for the live view and the server has confirmed the result. */
function waitFor<T>(z: ParasocialZero, q: unknown, pred: (d: T) => boolean, ms = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const view = z.materialize(q as never);
    let last: unknown;
    const timer = setTimeout(() => {
      view.destroy();
      reject(new Error(`timed out; last data: ${JSON.stringify(last)}`));
    }, ms);
    view.addListener((d, resultType) => {
      last = d;
      if (resultType === "complete" && pred(d as T)) {
        clearTimeout(timer);
        const snapshot = structuredClone(d) as T;
        queueMicrotask(() => view.destroy());
        resolve(snapshot);
      }
    });
  });
}

describe.skipIf(!enabled)("real zero-cache", () => {
  beforeAll(async () => {
    db = createDb(process.env.ZERO_E2E_DB!);
    // Test-only auth: zero-cache forwards the client's `auth` as a bearer token.
    const resolveUser = async (req: Request) => {
      const t = req.headers.get("authorization")?.replace(/^Bearer /, "");
      const id = t ? tokens.get(t) : undefined;
      return id ? { userID: id } : null;
    };
    const config = { appOrigin: "http://localhost", engineOrigins: ["http://engine.localhost"], zeroApiKey: process.env.ZERO_E2E_API_KEY };
    const mutate = createMutateHandler({ db, config, resolveUser });
    const query = createQueryHandler({ config, resolveUser });
    server = Bun.serve({
      port: Number(process.env.ZERO_E2E_PORT ?? 53000),
      hostname: "0.0.0.0",
      fetch(req) {
        const p = new URL(req.url).pathname;
        if (p === "/api/zero/mutate") return mutate(req);
        if (p === "/api/zero/query") return query(req);
        return new Response("not found", { status: 404 });
      },
    });
  });

  afterAll(async () => {
    for (const z of clients) await z.close();
    server?.stop(true);
    await db?.close();
  });

  test("mutations round-trip through zero-cache; replication reaches clients; queries enforce membership", async () => {
    const ada = await user("Ada");
    const bob = await user("Bob");
    const docID = crypto.randomUUID();

    // 1. custom mutator: optimistic on the client, authoritative on the server via the push endpoint
    const r = ada.z.mutate(mutators.document.create({ id: docID, name: "Bracket" }));
    expect((await r.client).type).toBe("success");
    expect((await r.server).type).toBe("success");
    const [row] = await db.sql`SELECT owner_id FROM documents WHERE id = ${docID}`;
    expect(row?.owner_id).toBe(ada.id);

    // 2. a write made directly in Postgres replicates to the client
    await db.sql`UPDATE documents SET name = 'Renamed upstream' WHERE id = ${docID}`;
    const docs = await waitFor<{ name: string }[]>(ada.z, queries.documents.mine(), (d) => d.some((x) => x.name === "Renamed upstream"));
    expect(docs.map((d) => d.name)).toContain("Renamed upstream");

    // 3. versions created server-side sync back
    const w = ada.z.mutate(mutators.script.write({ documentID: docID, path: "studios/bracket.ts", content: "export default 1;\n", baseVersion: null }));
    expect((await w.server).type).toBe("success");
    const vs = await waitFor<{ number: number; message: string }[]>(ada.z, queries.versions({ documentID: docID }), (d) => d.length === 1);
    expect(vs[0]).toMatchObject({ number: 1, message: "Create studios/bracket.ts" });

    // 4. stale write is rejected by the server with the current content
    const stale = ada.z.mutate(mutators.script.write({ documentID: docID, path: "studios/bracket.ts", content: "x", baseVersion: 0 }));
    const res = await stale.server;
    expect(res.type).toBe("error");
    if (res.type === "error" && res.error.type === "app") expect(res.error.details).toMatchObject({ code: "stale", current: { version: 1 } });

    // 5. Bob is not a member: synced queries return nothing, writes are refused
    const bobDocs = await waitFor<unknown[]>(bob.z, queries.documents.mine(), () => true);
    expect(bobDocs).toEqual([]);
    const bobScripts = await waitFor<unknown[]>(bob.z, queries.scripts({ documentID: docID }), () => true);
    expect(bobScripts).toEqual([]);
    const denied = await bob.z.mutate(mutators.document.rename({ id: docID, name: "mine" })).server;
    expect(denied.type).toBe("error");
  }, 60_000);
});
