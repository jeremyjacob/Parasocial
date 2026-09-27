import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mutators, applyEdits, PARAMS_COALESCE_MS } from "../src/mutators.ts";
import { runMutator } from "../src/server/zero.ts";
import { zql } from "../src/schema.ts";
import { validateScriptPath, sha256Hex } from "../src/util.ts";
import type { NoteAnchor } from "../src/types.ts";
import { createAgentSession, createTestDb, createUser, newDoc, run, type TestDb } from "./helpers.ts";

let db: TestDb;
let ada: string;
let bob: string;

beforeAll(async () => {
  db = await createTestDb();
  ada = await createUser(db, "Ada");
  bob = await createUser(db, "Bob");
});
afterAll(async () => {
  setSystemTime();
  await db.drop();
});

const versions = (documentID: string) => db.zql.run(zql.versions.where("documentID", documentID).orderBy("number", "asc"));
const script = (documentID: string, path: string) =>
  db.zql.run(zql.scripts.where("documentID", documentID).where("path", path).one());

describe("paths", () => {
  test("only parts/*.ts and lib/**/*.ts", () => {
    for (const ok of ["parts/bracket.ts", "parts/lid-2.ts", "lib/gears.ts", "lib/a/b/holes.ts"])
      expect(validateScriptPath(ok)).toBeNull();
    for (const bad of ["bracket.ts", "parts/a/b.ts", "parts/x.js", "lib/../x.ts", "/parts/x.ts", "parts/.hidden.ts", "src/x.ts", "lib//x.ts", "parts/"])
      expect(validateScriptPath(bad)).not.toBeNull();
  });

  test("write_script rejects a bad path", async () => {
    const doc = await newDoc(db, ada);
    const r = await runMutator(db, mutators.script.write({ documentID: doc, path: "../etc/passwd.ts", content: "x", baseVersion: null }), { userID: ada });
    expect(r).toMatchObject({ ok: false, details: { code: "invalid_path" } });
  });
});

describe("scripts and versions", () => {
  test("every write creates a version; baseVersion guards concurrency", async () => {
    const doc = await newDoc(db, ada);
    await run(db, mutators.script.write({ documentID: doc, path: "parts/bracket.ts", content: "export default 1;\n", baseVersion: null }), { userID: ada });
    let s = await script(doc, "parts/bracket.ts");
    expect(s?.version).toBe(1);
    expect(s?.contentHash).toBe(await sha256Hex("export default 1;\n"));

    await run(db, mutators.script.write({ documentID: doc, path: "parts/bracket.ts", content: "export default 2;\n", baseVersion: 1, message: "bump" }), { userID: ada });
    s = await script(doc, "parts/bracket.ts");
    expect(s?.version).toBe(2);

    // stale: someone writes against version 1 again
    const stale = await runMutator(db, mutators.script.write({ documentID: doc, path: "parts/bracket.ts", content: "export default 3;\n", baseVersion: 1 }), { userID: ada });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.details.code).toBe("stale");
      expect(stale.details.current).toEqual({ content: "export default 2;\n", version: 2, contentHash: await sha256Hex("export default 2;\n") });
    }

    // creating an existing path is rejected with the current content
    const exists = await runMutator(db, mutators.script.write({ documentID: doc, path: "parts/bracket.ts", content: "x", baseVersion: null }), { userID: ada });
    expect(exists).toMatchObject({ ok: false, details: { code: "exists", current: { version: 2 } } });

    const vs = await versions(doc);
    expect(vs.map((v) => [v.number, v.kind, v.message])).toEqual([
      [1, "script", "Create parts/bracket.ts"],
      [2, "script", "bump"],
    ]);
    expect(vs[1]!.snapshot.scripts).toEqual({ "parts/bracket.ts": await sha256Hex("export default 2;\n") });
    const doc_ = await db.zql.run(zql.documents.where("id", doc).one());
    expect(doc_?.headVersion).toBe(2);

    // version contents are stored server-side, not in synced tables
    const [row] = await db.sql`SELECT content FROM script_contents WHERE hash = ${vs[0]!.snapshot.scripts["parts/bracket.ts"]!}`;
    expect(row?.content).toBe("export default 1;\n");
  });

  test("edit_script applies search/replace edits", async () => {
    const doc = await newDoc(db, ada);
    await run(db, mutators.script.write({ documentID: doc, path: "lib/holes.ts", content: "const r = 3;\nconst d = r * 2;\n", baseVersion: null }), { userID: ada });
    await run(db, mutators.script.edit({ documentID: doc, path: "lib/holes.ts", baseVersion: 1, edits: [{ search: "r = 3", replace: "r = 4" }] }), { userID: ada });
    expect((await script(doc, "lib/holes.ts"))?.content).toBe("const r = 4;\nconst d = r * 2;\n");

    const ambiguous = await runMutator(db, mutators.script.edit({ documentID: doc, path: "lib/holes.ts", baseVersion: 2, edits: [{ search: "const", replace: "let" }] }), { userID: ada });
    expect(ambiguous).toMatchObject({ ok: false, details: { code: "edit_failed", index: 0 } });
    const all = await runMutator(db, mutators.script.edit({ documentID: doc, path: "lib/holes.ts", baseVersion: 2, edits: [{ search: "const", replace: "let", all: true }] }), { userID: ada });
    expect(all.ok).toBe(true);
    expect((await script(doc, "lib/holes.ts"))?.content).toBe("let r = 4;\nlet d = r * 2;\n");
  });

  test("applyEdits reports the failing edit", () => {
    expect(applyEdits("abc", [{ search: "b", replace: "x" }, { search: "zzz", replace: "" }])).toEqual({ ok: false, index: 1, reason: "search text not found" });
  });

  test("delete_script needs a current baseVersion and creates a version", async () => {
    const doc = await newDoc(db, ada);
    await run(db, mutators.script.write({ documentID: doc, path: "parts/a.ts", content: "a", baseVersion: null }), { userID: ada });
    await run(db, mutators.script.write({ documentID: doc, path: "parts/b.ts", content: "b", baseVersion: null }), { userID: ada });
    const stale = await runMutator(db, mutators.script.delete({ documentID: doc, path: "parts/a.ts", baseVersion: 2 }), { userID: ada });
    expect(stale).toMatchObject({ ok: false, details: { code: "stale" } });
    await run(db, mutators.script.delete({ documentID: doc, path: "parts/a.ts", baseVersion: 1 }), { userID: ada });
    expect(await script(doc, "parts/a.ts")).toBeUndefined();
    const vs = await versions(doc);
    expect(vs.at(-1)?.message).toBe("Delete parts/a.ts");
    expect(Object.keys(vs.at(-1)!.snapshot.scripts)).toEqual(["parts/b.ts"]);
  });

  test("identical content is a no-op (no version)", async () => {
    const doc = await newDoc(db, ada);
    await run(db, mutators.script.write({ documentID: doc, path: "parts/a.ts", content: "a", baseVersion: null }), { userID: ada });
    await run(db, mutators.script.write({ documentID: doc, path: "parts/a.ts", content: "a", baseVersion: 1 }), { userID: ada });
    expect((await versions(doc)).length).toBe(1);
  });

  test("agent writes record the agent session as author and link a note", async () => {
    const doc = await newDoc(db, ada);
    const agent = await createAgentSession(db, ada);
    await run(db, mutators.script.write({ documentID: doc, path: "parts/a.ts", content: "a", baseVersion: null, noteID: "n1", message: "Thicker wall" }), { userID: ada, agentSessionID: agent });
    const [v] = await versions(doc);
    expect(v).toMatchObject({ authorUserID: ada, authorAgentID: agent, noteID: "n1", message: "Thicker wall" });
  });

  test("an agent session of another user is rejected", async () => {
    const doc = await newDoc(db, ada);
    const bobsAgent = await createAgentSession(db, bob);
    await run(db, mutators.document.create({ id: "shared-" + doc, name: "x" }), { userID: ada });
    const r = await runMutator(db, mutators.script.write({ documentID: doc, path: "parts/a.ts", content: "a", baseVersion: null }), { userID: ada, agentSessionID: bobsAgent });
    expect(r).toMatchObject({ ok: false, details: { code: "forbidden" } });
  });

  test("restore_version copies a version to the tip", async () => {
    const doc = await newDoc(db, ada);
    const cfg = crypto.randomUUID();
    await run(db, mutators.script.write({ documentID: doc, path: "parts/a.ts", content: "v1", baseVersion: null }), { userID: ada });
    await run(db, mutators.configuration.create({ id: cfg, documentID: doc, name: "M3", overrides: [{ part: "parts/a.ts", name: "t", expression: "3", value: 3 }] }), { userID: ada });
    const v2 = (await versions(doc)).at(-1)!;
    expect(v2.number).toBe(2);
    await run(db, mutators.script.write({ documentID: doc, path: "parts/a.ts", content: "v3", baseVersion: 1 }), { userID: ada });
    await run(db, mutators.script.write({ documentID: doc, path: "lib/extra.ts", content: "x", baseVersion: null }), { userID: ada });
    setSystemTime(new Date(Date.now() + PARAMS_COALESCE_MS * 2));
    await run(db, mutators.param.set({ documentID: doc, configurationID: cfg, part: "parts/a.ts", name: "t", expression: "5", value: 5 }), { userID: ada });
    setSystemTime();

    await run(db, mutators.version.restore({ documentID: doc, versionID: v2.id }), { userID: ada });
    const vs = await versions(doc);
    const tip = vs.at(-1)!;
    expect(tip).toMatchObject({ number: 6, kind: "restore", message: "Restored from v2", restoredFrom: v2.id });
    expect(tip.snapshot).toEqual(v2.snapshot);
    expect((await script(doc, "parts/a.ts"))?.content).toBe("v1");
    expect((await script(doc, "parts/a.ts"))?.version).toBe(6);
    expect(await script(doc, "lib/extra.ts")).toBeUndefined();
    const ov = await db.zql.run(zql.paramOverrides.where("configurationID", cfg));
    expect(ov.map((o) => o.expression)).toEqual(["3"]);
    // nothing was overwritten: all earlier versions still exist
    expect(vs.map((v) => v.number)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("params and configurations", () => {
  test("a burst of param changes coalesces into one version", async () => {
    const doc = await newDoc(db, ada);
    const cfg = crypto.randomUUID();
    await run(db, mutators.configuration.create({ id: cfg, documentID: doc, name: "Print" }), { userID: ada });
    const set = (expression: string, value: number, name = "thickness") =>
      run(db, mutators.param.set({ documentID: doc, configurationID: cfg, part: "parts/bracket.ts", name, expression, value, codeDefault: "3" }), { userID: ada });
    await set("4", 4);
    await set("5", 5);
    await set("50", 50, "width");
    let vs = await versions(doc);
    expect(vs.length).toBe(1);
    expect(vs[0]!.message).toBe("Params: +Print, thickness 3 → 5, width 3 → 50");
    expect(vs[0]!.snapshot.params.configurations[0]!.overrides.map((o) => [o.name, o.value])).toEqual([
      ["thickness", 5],
      ["width", 50],
    ]);

    // another author breaks the burst
    await run(db, mutators.document.create({ id: `${doc}-x`, name: "x" }), { userID: bob });
    await db.sql`INSERT INTO document_members (document_id, user_id, role) VALUES (${doc}, ${bob}, 'editor')`;
    await run(db, mutators.param.reset({ documentID: doc, configurationID: cfg, part: "parts/bracket.ts", name: "width", codeDefault: "40" }), { userID: bob });
    vs = await versions(doc);
    expect(vs.map((v) => v.message)).toEqual(["Params: +Print, thickness 3 → 5, width 3 → 50", "Params: width 50 → 40"]);

    // after the window, a new version starts
    setSystemTime(new Date(Date.now() + PARAMS_COALESCE_MS + 1000));
    await run(db, mutators.param.set({ documentID: doc, configurationID: cfg, part: "parts/bracket.ts", name: "thickness", expression: "6", value: 6 }), { userID: bob });
    setSystemTime();
    vs = await versions(doc);
    expect(vs.length).toBe(3);
    expect(vs[2]!.message).toBe("Params: thickness 5 → 6");
  });

  test("a script write between param changes ends the burst", async () => {
    const doc = await newDoc(db, ada);
    const cfg = crypto.randomUUID();
    await run(db, mutators.configuration.create({ id: cfg, documentID: doc, name: "A" }), { userID: ada });
    await run(db, mutators.script.write({ documentID: doc, path: "parts/p.ts", content: "p", baseVersion: null }), { userID: ada });
    await run(db, mutators.param.set({ documentID: doc, configurationID: cfg, part: "parts/p.ts", name: "t", expression: "2", value: 2 }), { userID: ada });
    expect((await versions(doc)).map((v) => v.kind)).toEqual(["params", "script", "params"]);
  });

  test("configuration duplicate / rename / delete", async () => {
    const doc = await newDoc(db, ada);
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await run(db, mutators.configuration.create({ id: a, documentID: doc, name: "M3", overrides: [{ part: "parts/x.ts", name: "d", expression: "3 mm", value: 3 }] }), { userID: ada });
    await run(db, mutators.configuration.duplicate({ id: b, sourceID: a, name: "M4" }), { userID: ada });
    await run(db, mutators.configuration.rename({ id: b, name: "M5" }), { userID: ada });
    const dup = await runMutator(db, mutators.configuration.rename({ id: b, name: "M3" }), { userID: ada });
    expect(dup).toMatchObject({ ok: false, details: { code: "exists" } });
    const reserved = await runMutator(db, mutators.configuration.create({ id: crypto.randomUUID(), documentID: doc, name: "Default" }), { userID: ada });
    expect(reserved).toMatchObject({ ok: false, details: { code: "invalid" } });
    const bOverrides = await db.zql.run(zql.paramOverrides.where("configurationID", b));
    expect(bOverrides.map((o) => o.expression)).toEqual(["3 mm"]);
    await run(db, mutators.configuration.delete({ id: a }), { userID: ada });
    const cfgs = await db.zql.run(zql.configurations.where("documentID", doc));
    expect(cfgs.map((c) => c.name)).toEqual(["M5"]);
    const [v] = await versions(doc);
    // M3 was created and deleted within the same burst, so it nets out; M4 was created then renamed.
    expect(v!.message).toBe("Params: +M5");
  });
});

const anchor = (snapshot: string): NoteAnchor => ({
  targets: [{ kind: "face", name: "bracket/extrude1 · cap.end", point: [0, 0, 3], normal: [0, 0, 1] }],
  camera: { position: [10, 10, 10], target: [0, 0, 0], up: [0, 0, 1], fov: 45, ortho: false },
  version: "v1",
  configuration: "Default",
  snapshot,
});

async function putBlob(content = crypto.randomUUID()) {
  const hash = await sha256Hex(content);
  await db.sql`INSERT INTO blobs (hash, size, content_type) VALUES (${hash}, ${content.length}, 'image/png')`;
  return hash;
}

describe("notes", () => {
  test("create requires the snapshot blob to exist and bumps its refcount", async () => {
    const doc = await newDoc(db, ada);
    const missing = await runMutator(db, mutators.note.create({ id: crypto.randomUUID(), documentID: doc, anchor: anchor("a".repeat(64)), text: "hi" }), { userID: ada });
    expect(missing).toMatchObject({ ok: false, details: { code: "blob_missing" } });

    const hash = await putBlob();
    const noteID = crypto.randomUUID();
    const strokeID = crypto.randomUUID();
    await run(db, mutators.markup.add({ id: strokeID, documentID: doc, part: "parts/bracket.ts", points: [[0, 0, 0], [1, 1, 1]], color: "#f00" }), { userID: ada });
    await run(db, mutators.note.create({ id: noteID, documentID: doc, anchor: anchor(hash), text: "wall too thin", strokeIDs: [strokeID] }), { userID: ada });
    const note = await db.zql.run(zql.notes.where("id", noteID).related("messages").related("strokes").one());
    expect(note).toMatchObject({ status: "Open", orphaned: false, snapshotHash: hash });
    expect(note!.messages.map((m) => m.text)).toEqual(["wall too thin"]);
    expect(note!.strokes.map((s) => s.id)).toEqual([strokeID]);
    const [b] = await db.sql`SELECT refcount FROM blobs WHERE hash = ${hash}`;
    expect(b?.refcount).toBe(1);
  });

  test("lifecycle: claim, conflicting claim, awaiting review, human reply reopens", async () => {
    const doc = await newDoc(db, ada);
    const hash = await putBlob();
    const noteID = crypto.randomUUID();
    await run(db, mutators.note.create({ id: noteID, documentID: doc, anchor: anchor(hash), text: "fix" }), { userID: ada });
    const a1 = await createAgentSession(db, ada, "Claude Code", "refactor");
    const a2 = await createAgentSession(db, ada, "Cursor");

    const humanClaim = await runMutator(db, mutators.note.claim({ noteID }), { userID: ada });
    expect(humanClaim).toMatchObject({ ok: false, details: { code: "forbidden" } });

    await run(db, mutators.note.claim({ noteID }), { userID: ada, agentSessionID: a1 });
    let note = await db.zql.run(zql.notes.where("id", noteID).one());
    expect(note).toMatchObject({ status: "AgentWorking", claimedBy: a1 });
    expect((await db.zql.run(zql.agentSessions.where("id", a1).one()))?.status).toBe("working");

    const conflict = await runMutator(db, mutators.note.claim({ noteID }), { userID: ada, agentSessionID: a2 });
    expect(conflict).toMatchObject({ ok: false, message: "Claimed by Claude Code (refactor)", details: { code: "claimed", holder: { id: a1 } } });
    const wrongRelease = await runMutator(db, mutators.note.release({ noteID }), { userID: ada, agentSessionID: a2 });
    expect(wrongRelease).toMatchObject({ ok: false, details: { code: "claimed" } });

    // agent logs activity, writes a version, replies with it and asks for review
    await run(db, mutators.note.reply({ id: crypto.randomUUID(), noteID, text: "render iso", kind: "activity", data: { action: "render" } }), { userID: ada, agentSessionID: a1 });
    const versionID = crypto.randomUUID();
    await run(db, mutators.script.write({ documentID: doc, path: "parts/p.ts", content: "p", baseVersion: null, noteID, versionID }), { userID: ada, agentSessionID: a1 });
    await run(db, mutators.note.reply({ id: crypto.randomUUID(), noteID, text: "Done, 2mm now", versionID }), { userID: ada, agentSessionID: a1 });
    await run(db, mutators.note.setStatus({ noteID, status: "AwaitingReview" }), { userID: ada, agentSessionID: a1 });
    note = await db.zql.run(zql.notes.where("id", noteID).one());
    expect(note).toMatchObject({ status: "AwaitingReview", claimedBy: null });

    // a human reply moves it back to Open
    await run(db, mutators.note.reply({ id: crypto.randomUUID(), noteID, text: "Still thin on the left" }), { userID: ada });
    const thread = await db.zql.run(zql.notes.where("id", noteID).related("messages", (m) => m.orderBy("createdAt", "asc")).one());
    expect(thread?.status).toBe("Open");
    expect(thread!.messages.map((m) => [m.kind, m.versionID ?? null])).toEqual([
      ["message", null],
      ["activity", null],
      ["message", versionID],
      ["message", null],
    ]);

    // a2 can claim now; release returns it to Open
    await run(db, mutators.note.claim({ noteID }), { userID: ada, agentSessionID: a2 });
    await run(db, mutators.note.release({ noteID }), { userID: ada, agentSessionID: a2 });
    expect((await db.zql.run(zql.notes.where("id", noteID).one()))).toMatchObject({ status: "Open", claimedBy: null });
  });

  test("soft delete, restore, re-anchor, orphaned flag", async () => {
    const doc = await newDoc(db, ada);
    const hash = await putBlob();
    const noteID = crypto.randomUUID();
    await run(db, mutators.note.create({ id: noteID, documentID: doc, anchor: anchor(hash) }), { userID: ada });
    await run(db, mutators.note.setOrphaned({ noteID, orphaned: true }), { userID: ada });
    await run(db, mutators.note.remove({ noteID }), { userID: ada });
    let note = await db.zql.run(zql.notes.where("id", noteID).one());
    expect(note?.removedAt).toBeNumber();
    expect(note?.orphaned).toBe(true);
    await run(db, mutators.note.restore({ noteID }), { userID: ada });
    const moved = { ...anchor(hash), targets: [{ kind: "edge" as const, name: "bracket/fillet1 · edge", point: [1, 2, 3] as [number, number, number] }] };
    await run(db, mutators.note.reanchor({ noteID, anchor: moved }), { userID: ada });
    note = await db.zql.run(zql.notes.where("id", noteID).one());
    expect(note).toMatchObject({ removedAt: null, orphaned: false });
    expect(note!.anchor.targets[0]!.kind).toBe("edge");
  });
});

describe("permissions", () => {
  test("non-members are denied everywhere", async () => {
    const doc = await newDoc(db, ada);
    const hash = await putBlob();
    await run(db, mutators.script.write({ documentID: doc, path: "parts/a.ts", content: "a", baseVersion: null }), { userID: ada });
    const denied = [
      mutators.document.rename({ id: doc, name: "mine now" }),
      mutators.document.delete({ id: doc }),
      mutators.script.write({ documentID: doc, path: "parts/a.ts", content: "b", baseVersion: 1 }),
      mutators.script.delete({ documentID: doc, path: "parts/a.ts", baseVersion: 1 }),
      mutators.note.create({ id: crypto.randomUUID(), documentID: doc, anchor: anchor(hash) }),
      mutators.configuration.create({ id: crypto.randomUUID(), documentID: doc, name: "X" }),
      mutators.presence.set({ id: crypto.randomUUID(), documentID: doc, selection: [] }),
      mutators.markup.add({ id: crypto.randomUUID(), documentID: doc, part: "p", points: [[0, 0, 0]], color: "#000" }),
    ];
    for (const mr of denied) {
      const r = await runMutator(db, mr, { userID: bob });
      expect(r).toMatchObject({ ok: false, details: { code: "forbidden" } });
    }
    expect((await db.zql.run(zql.documents.where("id", doc).one()))?.name).toBe("Bracket");
  });

  test("viewers can note but not write scripts; only owners delete", async () => {
    const doc = await newDoc(db, ada);
    const carol = await createUser(db, "Carol");
    await db.sql`INSERT INTO document_members (document_id, user_id, role) VALUES (${doc}, ${carol}, 'viewer')`;
    const w = await runMutator(db, mutators.script.write({ documentID: doc, path: "parts/a.ts", content: "a", baseVersion: null }), { userID: carol });
    expect(w).toMatchObject({ ok: false, details: { code: "forbidden" } });
    const hash = await putBlob();
    expect((await runMutator(db, mutators.note.create({ id: crypto.randomUUID(), documentID: doc, anchor: anchor(hash) }), { userID: carol })).ok).toBe(true);
    await db.sql`UPDATE document_members SET role = 'editor' WHERE document_id = ${doc} AND user_id = ${carol}`;
    expect((await runMutator(db, mutators.document.delete({ id: doc }), { userID: carol })).ok).toBe(false);
    expect((await runMutator(db, mutators.document.delete({ id: doc }), { userID: ada })).ok).toBe(true);
    expect(await db.zql.run(zql.documents.where("id", doc).one())).toBeUndefined();
  });

  test("presence rows belong to their user", async () => {
    const doc = await newDoc(db, ada);
    await db.sql`INSERT INTO document_members (document_id, user_id, role) VALUES (${doc}, ${bob}, 'editor')`;
    const pid = crypto.randomUUID();
    await run(db, mutators.presence.set({ id: pid, documentID: doc, selection: [{ kind: "face", name: "f1" }] }), { userID: ada });
    const r = await runMutator(db, mutators.presence.set({ id: pid, documentID: doc, selection: [] }), { userID: bob });
    expect(r).toMatchObject({ ok: false, details: { code: "forbidden" } });
    const p = await db.zql.run(zql.presence.where("id", pid).one());
    expect(p?.selection).toEqual([{ kind: "face", name: "f1" }]);
  });
});
