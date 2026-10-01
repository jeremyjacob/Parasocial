/**
 * Script writes under concurrency (two agents on one document): strict compare-and-swap on
 * baseVersion, atomic multi-file writes, and retry safety.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mutators } from "../src/mutators.ts";
import { runMutator } from "../src/server/zero.ts";
import { zql } from "../src/schema.ts";
import { createAgentSession, createTestDb, createUser, newDoc, run, type TestDb } from "./helpers.ts";

let db: TestDb;
let ada: string;
let claude: string;
let codex: string;

beforeAll(async () => {
  db = await createTestDb();
  ada = await createUser(db, "Ada");
  claude = await createAgentSession(db, ada, "Claude Code");
  codex = await createAgentSession(db, ada, "Codex");
});
afterAll(async () => {
  await db.drop();
});

const script = (documentID: string, path: string) => db.zql.run(zql.scripts.where("documentID", documentID).where("path", path).one());
const versionCount = async (documentID: string) => (await db.zql.run(zql.versions.where("documentID", documentID))).length;

describe("compare-and-swap", () => {
  test("concurrent writers holding the same baseVersion: exactly one wins, the rest are stale", async () => {
    for (let round = 0; round < 10; round++) {
      const doc = await newDoc(db, ada);
      await run(db, mutators.script.write({ documentID: doc, path: "lib/holes.ts", content: "export const r = 3;\n", baseVersion: null }), { userID: ada });
      await run(db, mutators.script.write({ documentID: doc, path: "studios/a.ts", content: "export default 1;\n", baseVersion: null }), { userID: ada });
      const base = (await script(doc, "lib/holes.ts"))!.version;
      // an edit (Claude's library change), full saves (Codex) and a multi-file write, all against the same base
      const writers = [
        { ctx: { userID: ada, agentSessionID: claude }, mr: mutators.script.edit({ documentID: doc, path: "lib/holes.ts", edits: [{ search: "r = 3", replace: "r = 4" }], baseVersion: base }), content: "export const r = 4;\n" },
        { ctx: { userID: ada, agentSessionID: codex }, mr: mutators.script.write({ documentID: doc, path: "lib/holes.ts", content: "export const r = 5;\n", baseVersion: base }), content: "export const r = 5;\n" },
        { ctx: { userID: ada, agentSessionID: codex }, mr: mutators.script.write({ documentID: doc, path: "lib/holes.ts", content: "export const r = 6;\n", baseVersion: base }), content: "export const r = 6;\n" },
        {
          ctx: { userID: ada },
          mr: mutators.script.writeMany({ documentID: doc, files: [{ path: "lib/holes.ts", content: "export const r = 7;\n", baseVersion: base }, { path: "studios/a.ts", content: "export default 7;\n", baseVersion: 2 }] }),
          content: "export const r = 7;\n",
        },
      ];
      const results = await Promise.all(writers.map((w) => runMutator(db, w.mr, w.ctx)));
      const winners = results.flatMap((r, i) => (r.ok ? [i] : []));
      expect(winners).toHaveLength(1);
      for (const r of results) if (!r.ok) expect(r.details.code).toBe("stale");
      expect((await script(doc, "lib/holes.ts"))!.content).toBe(writers[winners[0]!]!.content);
      expect(await versionCount(doc)).toBe(3);
    }
  });

  test("concurrent creates of the same path: one wins, the others see it exists", async () => {
    const doc = await newDoc(db, ada);
    const results = await Promise.all(
      [1, 2, 3].map((i) => runMutator(db, mutators.script.write({ documentID: doc, path: "lib/new.ts", content: `export const x = ${i};\n`, baseVersion: null }), { userID: ada })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results) if (!r.ok) expect(r.details.code).toBe("exists");
  });

  test("the conditional update holds even when a concurrent writer commits between the check and the write", async () => {
    // Another transaction changes the row without the document lock (the lock alone used to be the
    // only guard). Our write reads version 1, passes the check, then blocks on the row; when the
    // other commits, `UPDATE … WHERE version = 1` matches nothing and the write fails stale
    // instead of overwriting.
    const doc = await newDoc(db, ada);
    await run(db, mutators.script.write({ documentID: doc, path: "lib/a.ts", content: "a", baseVersion: null }), { userID: ada });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const holding = new Promise<void>((r) => (locked = r));
    const other = db.sql.begin(async (sql) => {
      await sql`UPDATE scripts SET version = 99, content = 'theirs' WHERE document_id = ${doc} AND path = 'lib/a.ts'`;
      locked();
      await gate;
    });
    await holding;
    const mine = runMutator(db, mutators.script.write({ documentID: doc, path: "lib/a.ts", content: "mine", baseVersion: 1 }), { userID: ada });
    await Bun.sleep(150); // let our write pass the version check and block on the row
    release();
    await other;
    expect(await mine).toMatchObject({ ok: false, details: { code: "stale", current: { content: "theirs", version: 99 } } });
    expect((await script(doc, "lib/a.ts"))!.content).toBe("theirs");
    expect(await versionCount(doc)).toBe(1);
  });
});

describe("write_scripts (writeMany)", () => {
  test("a lib change and its studios land as one version", async () => {
    const doc = await newDoc(db, ada);
    await run(db, mutators.script.write({ documentID: doc, path: "lib/size.ts", content: "export const w = 10;\n", baseVersion: null }), { userID: ada });
    await run(db, mutators.script.write({ documentID: doc, path: "studios/a.ts", content: "import { w } from '../lib/size';\nexport default w;\n", baseVersion: null }), { userID: ada });
    await run(db, mutators.script.write({ documentID: doc, path: "studios/old.ts", content: "x", baseVersion: null }), { userID: ada });
    const before = await versionCount(doc);
    await run(
      db,
      mutators.script.writeMany({
        documentID: doc,
        versionID: "many-1",
        files: [
          { path: "lib/size.ts", content: "export const width = 10;\n", baseVersion: 1 },
          { path: "studios/a.ts", edits: [{ search: "{ w }", replace: "{ width as w }" }], baseVersion: 2 },
          { path: "studios/b.ts", content: "export default 2;\n", baseVersion: null },
          { path: "studios/old.ts", delete: true, baseVersion: 3 },
        ],
      }),
      { userID: ada, agentSessionID: claude },
    );
    expect(await versionCount(doc)).toBe(before + 1);
    const v = await db.zql.run(zql.versions.where("id", "many-1").one());
    expect(v!.number).toBe(4);
    expect(v!.message).toBe("Edit lib/size.ts, studios/a.ts, studios/b.ts and 1 more");
    expect(Object.keys(v!.snapshot.scripts).sort()).toEqual(["lib/size.ts", "studios/a.ts", "studios/b.ts"]);
    for (const p of ["lib/size.ts", "studios/a.ts", "studios/b.ts"]) expect((await script(doc, p))!.version).toBe(4);
    expect((await script(doc, "studios/a.ts"))!.content).toContain("{ width as w }");
    expect(await script(doc, "studios/old.ts")).toBeUndefined();
  });

  test("any stale baseVersion rejects the whole write", async () => {
    const doc = await newDoc(db, ada);
    await run(db, mutators.script.write({ documentID: doc, path: "lib/size.ts", content: "a", baseVersion: null }), { userID: ada });
    await run(db, mutators.script.write({ documentID: doc, path: "studios/a.ts", content: "b", baseVersion: null }), { userID: ada });
    const r = await runMutator(
      db,
      mutators.script.writeMany({ documentID: doc, files: [{ path: "lib/size.ts", content: "A", baseVersion: 1 }, { path: "studios/a.ts", content: "B", baseVersion: 1 }] }),
      { userID: ada },
    );
    expect(r).toMatchObject({ ok: false, details: { code: "stale", path: "studios/a.ts", current: { version: 2 } } });
    expect((await script(doc, "lib/size.ts"))!.content).toBe("a");
    expect(await versionCount(doc)).toBe(2);
  });

  test("rejects duplicate paths and ambiguous entries", async () => {
    const doc = await newDoc(db, ada);
    const dup = await runMutator(db, mutators.script.writeMany({ documentID: doc, files: [{ path: "lib/a.ts", content: "a", baseVersion: null }, { path: "lib/a.ts", content: "b", baseVersion: null }] }), { userID: ada });
    expect(dup).toMatchObject({ ok: false, details: { code: "invalid" } });
    const both = await runMutator(db, mutators.script.writeMany({ documentID: doc, files: [{ path: "lib/a.ts", content: "a", delete: true, baseVersion: 1 }] }), { userID: ada });
    expect(both).toMatchObject({ ok: false, details: { code: "invalid" } });
  });
});

describe("retries", () => {
  test("a retried full write that already committed succeeds without a new version", async () => {
    const doc = await newDoc(db, ada);
    await run(db, mutators.script.write({ documentID: doc, path: "lib/a.ts", content: "one", baseVersion: null }), { userID: ada });
    await run(db, mutators.script.write({ documentID: doc, path: "lib/a.ts", content: "two", baseVersion: 1 }), { userID: ada });
    // same request again: base 1 is stale now, but the content is already there
    const again = await runMutator(db, mutators.script.write({ documentID: doc, path: "lib/a.ts", content: "two", baseVersion: 1 }), { userID: ada });
    expect(again.ok).toBe(true);
    const create = await runMutator(db, mutators.script.write({ documentID: doc, path: "lib/a.ts", content: "two", baseVersion: null }), { userID: ada });
    expect(create.ok).toBe(true);
    expect(await versionCount(doc)).toBe(2);
  });

  test("a retried edit whose effect is already there succeeds", async () => {
    const doc = await newDoc(db, ada);
    await run(db, mutators.script.write({ documentID: doc, path: "lib/a.ts", content: "const r = 3;\n", baseVersion: null }), { userID: ada });
    const edit = mutators.script.edit({ documentID: doc, path: "lib/a.ts", edits: [{ search: "r = 3", replace: "r = 4" }], baseVersion: 1 });
    await run(db, edit, { userID: ada });
    expect((await runMutator(db, edit, { userID: ada })).ok).toBe(true);
    expect(await versionCount(doc)).toBe(2);
    // but an edit against base 1 that would produce something else is still stale
    const other = await runMutator(db, mutators.script.edit({ documentID: doc, path: "lib/a.ts", edits: [{ search: "const", replace: "let" }], baseVersion: 1 }), { userID: ada });
    expect(other).toMatchObject({ ok: false, details: { code: "stale" } });
  });

  test("the same versionID twice commits once", async () => {
    const doc = await newDoc(db, ada);
    await run(db, mutators.script.write({ documentID: doc, path: "lib/a.ts", content: "x", baseVersion: null }), { userID: ada });
    const mr = mutators.script.writeMany({ documentID: doc, versionID: "retry-1", files: [{ path: "lib/a.ts", edits: [{ search: "x", replace: "xx", all: true }], baseVersion: 1 }] });
    await run(db, mr, { userID: ada });
    expect((await runMutator(db, mr, { userID: ada })).ok).toBe(true);
    expect((await script(doc, "lib/a.ts"))!.content).toBe("xx");
    expect(await versionCount(doc)).toBe(2);
  });

  test("deleting a script that is already gone succeeds", async () => {
    const doc = await newDoc(db, ada);
    await run(db, mutators.script.write({ documentID: doc, path: "lib/a.ts", content: "x", baseVersion: null }), { userID: ada });
    await run(db, mutators.script.delete({ documentID: doc, path: "lib/a.ts", baseVersion: 1 }), { userID: ada });
    expect((await runMutator(db, mutators.script.delete({ documentID: doc, path: "lib/a.ts", baseVersion: 1 }), { userID: ada })).ok).toBe(true);
    expect(await versionCount(doc)).toBe(2);
  });
});
