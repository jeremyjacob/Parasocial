import { afterAll, beforeAll, expect, test } from "bun:test";
import { mutators } from "../src/mutators.ts";
import { zql } from "../src/schema.ts";
import { captureInverse, captureInverseAll, isUndoable, type AnyMR, type Reader } from "../src/undo.ts";
import { sha256Hex } from "../src/util.ts";
import { createTestDb, createUser, newDoc, run, type TestDb } from "./helpers.ts";

let db: TestDb;
let ada: string;
let read: Reader;
beforeAll(async () => {
  db = await createTestDb();
  ada = await createUser(db);
  read = (q) => db.zql.run(q as never);
});
afterAll(() => db.drop());

/** do → undo → redo, checking state after each step. */
async function roundTrip(mr: AnyMR, snapshot: () => Promise<unknown>) {
  const before = await snapshot();
  const undo = await captureInverse(read, mr);
  expect(undo).not.toBeNull();
  await run(db, mr, { userID: ada });
  const after = await snapshot();
  expect(after).not.toEqual(before);
  const redo = await captureInverseAll(read, undo!);
  for (const m of undo!) await run(db, m, { userID: ada });
  expect(await snapshot()).toEqual(before);
  expect(redo).not.toBeNull();
  for (const m of redo!) await run(db, m, { userID: ada });
  expect(await snapshot()).toEqual(after);
}

test("param set / reset / resetAll round-trip", async () => {
  const doc = await newDoc(db, ada);
  const cfg = crypto.randomUUID();
  await run(db, mutators.configuration.create({ id: cfg, documentID: doc, name: "A", overrides: [{ part: "parts/a.ts", name: "w", expression: "40", value: 40 }] }), { userID: ada });
  const overrides = async () =>
    (await db.zql.run(zql.paramOverrides.where("configurationID", cfg))).map((o) => [o.part, o.name, o.expression, o.value]).sort();
  await roundTrip(mutators.param.set({ documentID: doc, configurationID: cfg, part: "parts/a.ts", name: "t", expression: "3", value: 3 }), overrides);
  await roundTrip(mutators.param.set({ documentID: doc, configurationID: cfg, part: "parts/a.ts", name: "w", expression: "=t*10", value: 30 }), overrides);
  await roundTrip(mutators.param.reset({ documentID: doc, configurationID: cfg, part: "parts/a.ts", name: "w" }), overrides);
  await roundTrip(mutators.param.resetAll({ documentID: doc, configurationID: cfg }), overrides);
});

test("configuration create / rename / delete round-trip", async () => {
  const doc = await newDoc(db, ada);
  const configs = async () =>
    (await db.zql.run(zql.configurations.where("documentID", doc).related("overrides"))).map((c) => [c.id, c.name, c.overrides.map((o) => o.expression)]);
  const id = crypto.randomUUID();
  await roundTrip(mutators.configuration.create({ id, documentID: doc, name: "M3", overrides: [{ part: "p", name: "d", expression: "3", value: 3 }] }), configs);
  await roundTrip(mutators.configuration.rename({ id, name: "M4" }), configs);
  await roundTrip(mutators.configuration.delete({ id }), configs);
});

test("note actions and markup round-trip", async () => {
  const doc = await newDoc(db, ada);
  const hash = await sha256Hex("snap");
  await db.sql`INSERT INTO blobs (hash, size, content_type) VALUES (${hash}, 4, 'image/png')`;
  const noteID = crypto.randomUUID();
  const anchor = {
    targets: [{ kind: "face" as const, name: "f", point: [0, 0, 0] as [number, number, number] }],
    camera: { position: [1, 1, 1] as [number, number, number], target: [0, 0, 0] as [number, number, number], up: [0, 0, 1] as [number, number, number], fov: 45, ortho: false },
    version: "v1",
    configuration: "Default",
    snapshot: hash,
  };
  const note = async () => {
    const n = await db.zql.run(zql.notes.where("id", noteID).related("messages").related("strokes").one());
    // Undo of note.create is a soft delete, so a removed note reads as absent.
    return n && n.removedAt === null ? { status: n.status, anchor: n.anchor, messages: n.messages.map((m) => m.text).sort(), strokes: n.strokes.map((s) => s.id) } : undefined;
  };
  await roundTrip(mutators.note.create({ id: noteID, documentID: doc, anchor, text: "thin" }), note);
  await run(db, mutators.note.setStatus({ noteID, status: "AwaitingReview" }), { userID: ada });
  await roundTrip(mutators.note.reply({ id: crypto.randomUUID(), noteID, text: "still thin" }), note); // reopens, undo restores AwaitingReview
  await roundTrip(mutators.note.setStatus({ noteID, status: "Resolved" }), note);
  await roundTrip(mutators.note.reanchor({ noteID, anchor: { ...anchor, targets: [{ kind: "edge", name: "e", point: [1, 0, 0] }] } }), note);
  await roundTrip(mutators.markup.add({ id: crypto.randomUUID(), documentID: doc, noteID, part: "p", points: [[0, 0, 0]], color: "#f00" }), note);
});

test("script writes and presence are not undoable (they go through Restore)", async () => {
  expect(isUndoable(mutators.script.write({ documentID: "d", path: "parts/a.ts", content: "", baseVersion: null }))).toBe(false);
  expect(isUndoable(mutators.presence.set({ id: "p", documentID: "d" }))).toBe(false);
  expect(await captureInverse(read, mutators.version.restore({ documentID: "d", versionID: "v" }))).toBeNull();
});
