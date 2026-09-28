import { afterAll, beforeAll, expect, test } from "bun:test";
import { mutators } from "@parasocial/sync";
import { runMutator } from "@parasocial/sync/server";
import { createTestDb, createUser, newDoc, run, type TestDb } from "../../sync/test/helpers";
import { createAgentDispatcher } from "../src/dispatcher";
import { builtinSession, type RunOptions, type RunOutcome } from "../src/run";
import { newNote, toolDeps } from "./helpers";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => db?.drop());

/** A dispatcher whose runs just record what they were given and reply as the built-in agent. */
function recording() {
  const runs: RunOptions[] = [];
  const gates: (() => void)[] = [];
  const fake = async (_deps: unknown, o: RunOptions): Promise<RunOutcome> => {
    runs.push(o);
    await new Promise<void>((r) => gates.push(r));
    const sessionID = await builtinSession({ db }, o.userID, o.documentID);
    await run(db, mutators.note.reply({ id: crypto.randomUUID(), noteID: o.noteID, text: "Which side?", kind: "message" } as any), { userID: o.userID, agentSessionID: sessionID });
    return "open";
  };
  const d = createAgentDispatcher(toolDeps(db), { run: fake, sweepMs: 0, log: () => {} });
  const finish = async () => {
    while (!gates.length) await Bun.sleep(5);
    gates.shift()!();
    await Bun.sleep(30);
    await d.scan();
  };
  return { d, runs, finish };
}

test("hand-off, one run per document, and waiting for the human after the agent speaks", async () => {
  const ada = await createUser(db, "Ada");
  const documentID = await newDoc(db, ada);
  const n1 = await newNote(db, ada, documentID, "first");
  const n2 = await newNote(db, ada, documentID, "second");
  const { d, runs, finish } = recording();
  try {
    await d.ready;
    expect(runs).toHaveLength(0); // nothing handed over; pickup is on by default but Ada has no provider

    await run(db, mutators.note.assignAgent({ noteID: n1, assign: true }), { userID: ada });
    await run(db, mutators.note.assignAgent({ noteID: n2, assign: true }), { userID: ada });
    await d.scan(documentID);
    expect(runs.map((r) => [r.noteID, r.userID])).toEqual([[n1, ada]]); // oldest first, one at a time

    await finish();
    expect(runs.map((r) => r.noteID)).toEqual([n1, n2]);
    await finish();
    expect(runs).toHaveLength(2); // both asked a question: nothing to do until someone answers

    await run(db, mutators.note.reply({ id: crypto.randomUUID(), noteID: n1, text: "The left one" } as any), { userID: ada });
    await d.scan(documentID);
    expect(runs.map((r) => r.noteID)).toEqual([n1, n2, n1]);
    await finish();

    // handing a note over again counts as new activity
    await run(db, mutators.note.assignAgent({ noteID: n2, assign: true }), { userID: ada });
    await d.scan(documentID);
    expect(runs.at(-1)?.noteID).toBe(n2);
    await finish();
  } finally {
    await d.stop();
  }
});

test("auto hand-off runs as whoever switched it on, and only while they can edit", async () => {
  const ada = await createUser(db, "Ada");
  const bob = await createUser(db, "Bob");
  const documentID = await newDoc(db, ada);
  const [created] = await db.sql`SELECT settings FROM documents WHERE id = ${documentID}`;
  expect(created!.settings.agent).toEqual({ autoHandoff: true, runAs: ada }); // on by default, as the creator
  await db.sql`INSERT INTO document_members (document_id, user_id, role) VALUES (${documentID}, ${bob}, 'editor')`;
  const note = await newNote(db, ada, documentID);
  const { d, runs, finish } = recording();
  try {
    await d.ready;
    // settings.agent can't be written through updateSettings (it decides whose provider pays)
    await run(db, mutators.document.updateSettings({ id: documentID, settings: { agent: { autoHandoff: true, runAs: ada } } } as any), { userID: bob });
    await d.scan(documentID);
    expect(runs).toHaveLength(0);

    await run(db, mutators.document.setAgentAutoHandoff({ id: documentID, enabled: true }), { userID: bob });
    await d.scan(documentID);
    expect(runs).toHaveLength(0); // pickup waits for Bob to set up a provider
    await db.sql`INSERT INTO user_agent_settings (user_id, provider, model) VALUES (${bob}, 'anthropic', 'm')`;
    const [doc] = await db.sql`SELECT settings FROM documents WHERE id = ${documentID}`;
    expect(doc!.settings.agent).toEqual({ autoHandoff: true, runAs: bob });
    await d.scan(documentID);
    expect(runs.map((r) => [r.noteID, r.userID])).toEqual([[note, bob]]);
    await finish();

    // Bob loses edit access: his provider no longer runs notes here
    await db.sql`UPDATE document_members SET role = 'viewer' WHERE document_id = ${documentID} AND user_id = ${bob}`;
    await newNote(db, ada, documentID, "another");
    await d.scan(documentID);
    expect(runs).toHaveLength(1);

    await run(db, mutators.document.setAgentAutoHandoff({ id: documentID, enabled: false }), { userID: ada });
    const [off] = await db.sql`SELECT settings FROM documents WHERE id = ${documentID}`;
    expect(off!.settings.agent).toEqual({ autoHandoff: false });
  } finally {
    await d.stop();
  }
});

test("taking a note back releases the built-in agent's claim; agents can't hand notes over", async () => {
  const ada = await createUser(db);
  const documentID = await newDoc(db, ada);
  const noteID = await newNote(db, ada, documentID);
  const sessionID = await builtinSession({ db }, ada, documentID);

  await run(db, mutators.note.assignAgent({ noteID, assign: true }), { userID: ada });
  await run(db, mutators.note.claim({ noteID }), { userID: ada, agentSessionID: sessionID });
  const r = await runMutator(db, mutators.note.assignAgent({ noteID, assign: true }), { userID: ada, agentSessionID: sessionID });
  expect(r.ok).toBe(false);

  await run(db, mutators.note.assignAgent({ noteID, assign: false }), { userID: ada });
  const [n] = await db.sql`SELECT status, claimed_by, agent_assigned_by FROM notes WHERE id = ${noteID}`;
  expect(n).toMatchObject({ status: "Open", claimed_by: null, agent_assigned_by: null });

  // a person releasing the claim also takes it off the agent's list
  await run(db, mutators.note.assignAgent({ noteID, assign: true }), { userID: ada });
  await run(db, mutators.note.claim({ noteID }), { userID: ada, agentSessionID: sessionID });
  await run(db, mutators.note.release({ noteID }), { userID: ada });
  const [m] = await db.sql`SELECT claimed_by, agent_assigned_by FROM notes WHERE id = ${noteID}`;
  expect(m).toMatchObject({ claimed_by: null, agent_assigned_by: null });
});

test("runs interrupted by a restart are given back and picked up again", async () => {
  const ada = await createUser(db);
  const documentID = await newDoc(db, ada);
  const noteID = await newNote(db, ada, documentID);
  const sessionID = await builtinSession({ db }, ada, documentID);
  await run(db, mutators.note.assignAgent({ noteID, assign: true }), { userID: ada });
  await run(db, mutators.note.claim({ noteID }), { userID: ada, agentSessionID: sessionID });

  const { d, runs, finish } = recording();
  try {
    await d.ready;
    expect(runs.map((r) => r.noteID)).toContain(noteID);
    await finish();
  } finally {
    await d.stop();
  }
});
