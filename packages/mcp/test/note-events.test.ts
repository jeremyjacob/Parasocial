import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mutators, sha256Hex, type NoteAnchor } from "@parasocial/sync";
import { createTestDb, createUser, createAgentSession, newDoc, run, type TestDb } from "../../sync/test/helpers.ts";
import { createNoteEvents, NoteCursor, type NoteEvents } from "../src/note-events";

let db: TestDb;
let events: NoteEvents;
let ada: string;

beforeAll(async () => {
  db = await createTestDb();
  events = createNoteEvents(db);
  ada = await createUser(db, "Ada");
});
afterAll(async () => db?.drop());

const anchor = (snapshot: string): NoteAnchor => ({
  targets: [{ kind: "face", part: "bracket", name: "bracket/extrude1 · cap.end", point: [0, 0, 3], normal: [0, 0, 1] } as any],
  camera: { position: [10, 10, 10], target: [0, 0, 0], up: [0, 0, 1], fov: 45, ortho: false },
  version: "v1",
  configuration: "Default",
  snapshot,
});

async function note(doc: string, text: string, ctx: { userID: string; agentSessionID?: string } = { userID: ada }) {
  const content = crypto.randomUUID();
  const hash = await sha256Hex(content);
  await db.sql`INSERT INTO blobs (hash, size, content_type) VALUES (${hash}, ${content.length}, 'image/png')`;
  const id = crypto.randomUUID();
  await run(db, mutators.note.create({ id, documentID: doc, anchor: anchor(hash), text }), ctx);
  return id;
}

describe("note events", () => {
  test("wait wakes on a new note and returns it once", async () => {
    const doc = await newDoc(db, ada);
    const agent = await createAgentSession(db, ada);
    const cursor = new NoteCursor(Date.now());
    const t0 = Date.now();
    const waiting = events.wait([doc], cursor, agent, { timeoutMs: 10_000, pollMs: 10_000 });
    await Bun.sleep(100);
    const id = await note(doc, "wall too thin");
    const found = await waiting;
    // woken by the notification, not the 10 s poll
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(found).toMatchObject([{ noteID: id, documentID: doc, created: true, replies: [] }]);
    // delivered: the next wait times out empty
    expect(await events.wait([doc], cursor, agent, { timeoutMs: 200 })).toEqual([]);
  });

  test("human replies count; agent replies, activity and the note's first message don't", async () => {
    const doc = await newDoc(db, ada);
    const agent = await createAgentSession(db, ada);
    const id = await note(doc, "fix");
    const cursor = new NoteCursor(Date.now());
    await run(db, mutators.note.reply({ id: crypto.randomUUID(), noteID: id, text: "done", versionID: undefined }), { userID: ada, agentSessionID: agent });
    await run(db, mutators.note.reply({ id: crypto.randomUUID(), noteID: id, text: "wrote", kind: "activity" }), { userID: ada, agentSessionID: agent });
    expect(await events.read([doc], cursor, agent)).toEqual([]);
    await run(db, mutators.note.reply({ id: crypto.randomUUID(), noteID: id, text: "still thin" }), { userID: ada });
    expect(await events.read([doc], cursor, agent)).toMatchObject([{ noteID: id, created: false, replies: [{ text: "still thin", author: "Ada" }] }]);
  });

  test("notes claimed by another agent and removed notes are skipped", async () => {
    const doc = await newDoc(db, ada);
    const me = await createAgentSession(db, ada, "Claude Code", "me");
    const other = await createAgentSession(db, ada, "Cursor");
    const cursor = new NoteCursor(Date.now() - 1);
    const held = await note(doc, "a");
    const gone = await note(doc, "b");
    await run(db, mutators.note.claim({ noteID: held }), { userID: ada, agentSessionID: other });
    await run(db, mutators.note.remove({ noteID: gone }), { userID: ada });
    expect(await events.read([doc], cursor, me)).toEqual([]);
  });

  test("events before the cursor are not returned; other documents are ignored", async () => {
    const doc = await newDoc(db, ada);
    const elsewhere = await newDoc(db, ada, "Other");
    const agent = await createAgentSession(db, ada);
    await note(doc, "old");
    await Bun.sleep(20);
    const cursor = new NoteCursor(Date.now());
    // "old" is inside the overlap window but before the cursor was made
    await note(elsewhere, "not mine");
    const later = await note(doc, "new");
    const got = await events.read([doc], cursor, agent);
    expect(got.map((a) => a.noteID)).toEqual([later]);
  });

  test("abort ends a wait early", async () => {
    const doc = await newDoc(db, ada);
    const agent = await createAgentSession(db, ada);
    const ac = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 100);
    expect(await events.wait([doc], new NoteCursor(Date.now()), agent, { timeoutMs: 10_000, signal: ac.signal })).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});
