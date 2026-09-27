/**
 * End-to-end through createPlatform: passkey sign-up → session cookie → the
 * Zero push endpoint (exactly what zero-cache calls) → Postgres; the query
 * endpoint; synced-query permission filtering; version contents.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutators } from "../src/mutators.ts";
import { queries } from "../src/queries.ts";
import { zql } from "../src/schema.ts";
import { createPlatform, FsBlobStore, type Platform } from "../src/server/index.ts";
import { createTestDb, createUser, newDoc, run, type TestDb } from "./helpers.ts";
import { SoftAuthenticator } from "./soft-authenticator.ts";

const ORIGIN = "https://cad.example.test";
const ENGINE = "https://engine.cad.example.test";

let db: TestDb;
let dir: string;
let platform: Platform;

beforeAll(async () => {
  db = await createTestDb();
  // zero-cache creates these in the upstream DB ("zero_0" shard schema); mimic them for the push protocol.
  await db.sql.unsafe(`
    CREATE SCHEMA zero_0;
    CREATE TABLE zero_0."clients" ("clientGroupID" TEXT NOT NULL, "clientID" TEXT NOT NULL, "lastMutationID" BIGINT NOT NULL, "userID" TEXT, PRIMARY KEY("clientGroupID", "clientID"));
    CREATE TABLE zero_0."mutations" ("clientGroupID" TEXT NOT NULL, "clientID" TEXT NOT NULL, "mutationID" BIGINT NOT NULL, "result" JSON NOT NULL, PRIMARY KEY("clientGroupID", "clientID", "mutationID"));`);
  dir = await mkdtemp(join(tmpdir(), "ps-platform-"));
  platform = await createPlatform({
    db,
    store: new FsBlobStore(dir),
    migrate: false,
    sweepIntervalMs: 0,
    config: {
      rpID: "cad.example.test",
      rpName: "Parasocial",
      appOrigin: ORIGIN,
      engineOrigins: [ENGINE],
      databaseURL: db.url,
      secret: "s".repeat(40),
      zeroApiKey: "zk",
      sessionTTLms: 3600_000,
      secureCookies: true,
    },
  });
});
afterAll(async () => {
  await db.drop();
  await rm(dir, { recursive: true, force: true });
});

async function signUp(name: string) {
  const a = new SoftAuthenticator(ORIGIN);
  const r1 = await platform.auth(new Request(`${ORIGIN}/api/auth/register/options`, { method: "POST", headers: { origin: ORIGIN }, body: JSON.stringify({ name }) }));
  const challengeCookie = r1.headers.getSetCookie()[0]!.split(";")[0]!;
  const response = await a.create(await r1.json());
  const r2 = await platform.auth(new Request(`${ORIGIN}/api/auth/register/verify`, { method: "POST", headers: { origin: ORIGIN, cookie: challengeCookie }, body: JSON.stringify({ response }) }));
  const session = r2.headers.getSetCookie().find((c) => c.startsWith("ps_session="))!.split(";")[0]!;
  const { user } = (await r2.json()) as { user: { userID: string } };
  return { cookie: session, userID: user.userID };
}

const mutationIDs = new Map<string, number>();
function push(cookie: string, name: string, args: unknown, opts: { origin?: string; apiKey?: string; clientID?: string } = {}) {
  const clientID = opts.clientID ?? "c1";
  const id = (mutationIDs.get(clientID) ?? 0) + 1;
  mutationIDs.set(clientID, id);
  return platform.mutate(
    new Request(`${ORIGIN}/api/zero/mutate?schema=zero_0&appID=zero`, {
      method: "POST",
      headers: { cookie, "x-api-key": opts.apiKey ?? "zk", ...(opts.origin ? { origin: opts.origin } : {}) },
      body: JSON.stringify({
        clientGroupID: "g1",
        pushVersion: 1,
        timestamp: Date.now(),
        requestID: crypto.randomUUID(),
        mutations: [{ type: "custom", id, clientID, name, args: [args], timestamp: Date.now() }],
      }),
    }),
  );
}

describe("Zero push endpoint", () => {
  test("runs mutators authoritatively as the cookie's user", async () => {
    const ada = await signUp("Ada");
    const res = await push(ada.cookie, "document.create", { id: "doc-1", name: "Bracket" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.kind).toBe("MutateResponse");
    expect(body.mutations[0].result).toEqual({});
    const doc = await db.zql.run(zql.documents.where("id", "doc-1").one());
    expect(doc?.ownerID).toBe(ada.userID);

    const w = (await (await push(ada.cookie, "script.write", { documentID: "doc-1", path: "studios/a.ts", content: "x", baseVersion: null })).json()) as any;
    expect(w.mutations[0].result).toEqual({});
    // stale write: the app error (with current content) is returned to the client
    const stale = (await (await push(ada.cookie, "script.write", { documentID: "doc-1", path: "studios/a.ts", content: "y", baseVersion: 0 })).json()) as any;
    expect(stale.mutations[0].result).toMatchObject({ error: "app", details: { code: "stale", current: { content: "x", version: 1 } } });
    // the failed mutation still advanced lastMutationID (it won't be retried)
    const [c] = await db.sql`SELECT "lastMutationID" FROM zero_0.clients WHERE "clientID" = 'c1'`;
    expect(Number(c!.lastMutationID)).toBe(mutationIDs.get("c1")!);
  });

  test("a browser can't impersonate an agent session", async () => {
    const eve = await signUp("Eve");
    await push(eve.cookie, "document.create", { id: "doc-eve", name: "E" }, { clientID: "eve" });
    // ctx on the push path never carries agentSessionID, so claims are rejected
    const hash = "a".repeat(64);
    await db.sql`INSERT INTO blobs (hash, size, content_type) VALUES (${hash}, 1, 'image/png') ON CONFLICT DO NOTHING`;
    const anchor = { targets: [{ kind: "part", name: "p", point: [0, 0, 0] }], camera: { position: [1, 1, 1], target: [0, 0, 0], up: [0, 0, 1], fov: 45, ortho: false }, version: "v", configuration: "Default", snapshot: hash };
    await push(eve.cookie, "note.create", { id: "n-eve", documentID: "doc-eve", anchor }, { clientID: "eve" });
    const r = (await (await push(eve.cookie, "note.claim", { noteID: "n-eve", agentSessionID: "whatever" }, { clientID: "eve" })).json()) as any;
    expect(r.mutations[0].result).toMatchObject({ error: "app", details: { code: "forbidden" } });
  });

  test("rejects: no session, wrong API key, engine origin", async () => {
    expect((await push("ps_session=nope", "document.create", { id: "x", name: "x" })).status).toBe(401);
    const ada = await signUp("Ada2");
    expect((await push(ada.cookie, "document.create", { id: "x", name: "x" }, { apiKey: "wrong" })).status).toBe(401);
    expect((await push(ada.cookie, "document.create", { id: "x", name: "x" }, { origin: ENGINE })).status).toBe(403);
    expect(await db.zql.run(zql.documents.where("id", "x").one())).toBeUndefined();
  });
});

describe("synced queries (permissions)", () => {
  test("every query returns nothing for non-members", async () => {
    const ada = await createUser(db, "A");
    const bob = await createUser(db, "B");
    const doc = await newDoc(db, ada);
    await run(db, mutators.script.write({ documentID: doc, path: "studios/a.ts", content: "a", baseVersion: null }), { userID: ada });
    const cfg = crypto.randomUUID();
    await run(db, mutators.configuration.create({ id: cfg, documentID: doc, name: "M3", overrides: [{ part: "studios/a.ts", name: "t", expression: "1", value: 1 }] }), { userID: ada });
    await run(db, mutators.presence.set({ id: crypto.randomUUID(), documentID: doc, selection: [] }), { userID: ada });

    const as = (userID: string | undefined) => ({
      mine: () => db.zql.run(queries.documents.mine.fn({ ctx: userID ? { userID } : undefined, args: undefined })),
      byID: () => db.zql.run(queries.documents.byID.fn({ ctx: userID ? { userID } : undefined, args: { documentID: doc } })),
      scripts: () => db.zql.run(queries.scripts.fn({ ctx: userID ? { userID } : undefined, args: { documentID: doc } })),
      versions: () => db.zql.run(queries.versions.fn({ ctx: userID ? { userID } : undefined, args: { documentID: doc } })),
      configurations: () => db.zql.run(queries.configurations.fn({ ctx: userID ? { userID } : undefined, args: { documentID: doc } })),
      overrides: () => db.zql.run(queries.paramOverrides.fn({ ctx: userID ? { userID } : undefined, args: { documentID: doc } })),
      presence: () => db.zql.run(queries.presence.fn({ ctx: userID ? { userID } : undefined, args: { documentID: doc } })),
      notes: () => db.zql.run(queries.notes.fn({ ctx: userID ? { userID } : undefined, args: { documentID: doc } })),
    });

    const owner = as(ada);
    expect((await owner.mine()).map((d) => d.id)).toEqual([doc]);
    expect((await owner.byID())?.members.map((m) => m.user?.name)).toEqual(["A"]);
    expect(await owner.scripts()).toHaveLength(1);
    expect(await owner.versions()).toHaveLength(2);
    expect((await owner.configurations())[0]!.overrides).toHaveLength(1);
    expect(await owner.overrides()).toHaveLength(1);
    expect(await owner.presence()).toHaveLength(1);

    for (const who of [bob, undefined]) {
      const q = as(who);
      expect(await q.mine()).toEqual([]);
      expect(await q.byID()).toBeUndefined();
      expect(await q.scripts()).toEqual([]);
      expect(await q.versions()).toEqual([]);
      expect(await q.configurations()).toEqual([]);
      expect(await q.overrides()).toEqual([]);
      expect(await q.presence()).toEqual([]);
      expect(await q.notes()).toEqual([]);
    }
  });

  test("the query endpoint transforms named queries", async () => {
    const ada = await signUp("Q");
    const res = await platform.query(
      new Request(`${ORIGIN}/api/zero/query?schema=zero_0&appID=zero`, {
        method: "POST",
        headers: { cookie: ada.cookie, "x-api-key": "zk" },
        body: JSON.stringify(["transform", [{ id: "q1", name: "documents.mine", args: [] }]]),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.kind).toBe("QueryResponse");
    expect(body.queries[0]).toMatchObject({ id: "q1", name: "documents.mine", ast: { table: "documents" } });
    expect(JSON.stringify(body.queries[0].ast)).toContain(ada.userID); // membership filter is baked into the AST
  });
});

describe("version contents", () => {
  test("members read a version's scripts; others get 404", async () => {
    const ada = await signUp("V");
    const bob = await signUp("W");
    await push(ada.cookie, "document.create", { id: "doc-v", name: "V" }, { clientID: "v" });
    await push(ada.cookie, "script.write", { documentID: "doc-v", path: "studios/a.ts", content: "one", baseVersion: null, versionID: "v1" }, { clientID: "v" });
    await push(ada.cookie, "script.write", { documentID: "doc-v", path: "studios/a.ts", content: "two", baseVersion: 1, versionID: "v2" }, { clientID: "v" });
    const get = (cookie: string, path: string) => platform.versions(new Request(`${ORIGIN}/api/versions/${path}`, { headers: { cookie } }));
    const r = await get(ada.cookie, "v1");
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).scripts).toEqual({ "studios/a.ts": "one" });
    expect(((await (await get(ada.cookie, "v2?path=studios/a.ts")).json()) as any).scripts).toEqual({ "studios/a.ts": "two" });
    expect((await get(bob.cookie, "v1")).status).toBe(404);
  });
});
