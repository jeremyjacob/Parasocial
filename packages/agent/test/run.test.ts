import { afterAll, beforeAll, expect, test } from "bun:test";
import { mutators } from "@parasocial/sync";
import { createTestDb, createUser, newDoc, run, type TestDb } from "../../sync/test/helpers";
import { runNote } from "../src/run";
import { saveAgentSettings } from "../src/settings";
import { newNote, scriptedModel, SECRET, toolDeps } from "./helpers";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => db?.drop());

const noteRow = async (id: string) => (await db.sql`SELECT status, claimed_by FROM notes WHERE id = ${id}`)[0];
const thread = async (id: string) =>
  (await db.sql`SELECT m.kind, m.text, a.builtin FROM note_messages m LEFT JOIN agent_sessions a ON a.id = m.author_agent_id WHERE m.note_id = ${id} ORDER BY m.created_at, m.id`) as unknown as { kind: string; text: string; builtin: boolean | null }[];

test("resolves a note through the MCP tools, as a built-in agent session scoped to the document", async () => {
  const userID = await createUser(db);
  const documentID = await newDoc(db, userID);
  const noteID = await newNote(db, userID, documentID);
  const m = scriptedModel([{ tool: "set_note_status", input: { id: noteID, status: "Resolved" } }, { text: "never reached" }]);

  expect(await runNote(toolDeps(db), { documentID, noteID, userID, model: m.model })).toBe("resolved");
  expect(m.calls()).toBe(1); // settling the note ends the run
  expect(await noteRow(noteID)).toMatchObject({ status: "Resolved", claimed_by: null });
  const [s] = await db.sql`SELECT client_name, builtin, status, document_id FROM agent_sessions WHERE user_id = ${userID}`;
  expect(s).toMatchObject({ client_name: "Agent", builtin: true, status: "idle", document_id: documentID });

  // the model saw the note and the document-scoped tools (no document argument, no document management)
  const call = (m.model as any).doGenerateCalls[0];
  const names = call.tools.map((t: any) => t.name);
  expect(names).toContain("edit_script");
  expect(names).not.toContain("delete_document");
  expect(names).not.toContain("wait_for_notes");
  expect(call.tools.find((t: any) => t.name === "edit_script").inputSchema.properties.document).toBeUndefined();
  expect(JSON.stringify(call.prompt)).toContain("Make it thicker");
});

test("a run that ends without settling gives the note back with its last words", async () => {
  const userID = await createUser(db);
  const documentID = await newDoc(db, userID);
  const noteID = await newNote(db, userID, documentID);
  const m = scriptedModel([{ text: "I couldn't find the wall this note points at." }]);

  expect(await runNote(toolDeps(db), { documentID, noteID, userID, model: m.model })).toBe("open");
  expect(await noteRow(noteID)).toMatchObject({ status: "Open", claimed_by: null });
  expect((await thread(noteID)).at(-1)).toMatchObject({ kind: "message", text: "I couldn't find the wall this note points at.", builtin: true });
});

test("a question left with reply_to_note stays open without an extra entry", async () => {
  const userID = await createUser(db);
  const documentID = await newDoc(db, userID);
  const noteID = await newNote(db, userID, documentID);
  const m = scriptedModel([{ tool: "reply_to_note", input: { id: noteID, text: "2 mm or 3 mm?", status: "Open" } }]);

  expect(await runNote(toolDeps(db), { documentID, noteID, userID, model: m.model })).toBe("open");
  expect(await noteRow(noteID)).toMatchObject({ status: "Open", claimed_by: null });
  const t = await thread(noteID);
  expect(t.filter((x) => x.builtin).map((x) => x.text)).toEqual(["2 mm or 3 mm?"]);
});

test("the step limit stops a run and says so", async () => {
  const userID = await createUser(db);
  const documentID = await newDoc(db, userID);
  const noteID = await newNote(db, userID, documentID);
  const m = scriptedModel([{ tool: "list_scripts", input: {} }]);

  expect(await runNote(toolDeps(db), { documentID, noteID, userID, model: m.model, maxSteps: 3 })).toBe("open");
  expect(m.calls()).toBe(3);
  expect(await noteRow(noteID)).toMatchObject({ status: "Open", claimed_by: null });
  expect((await thread(noteID)).at(-1)).toMatchObject({ kind: "message", text: "Stopped after 3 steps without finishing.", builtin: true });
});

test("a note another agent holds is left alone", async () => {
  const userID = await createUser(db);
  const documentID = await newDoc(db, userID);
  const noteID = await newNote(db, userID, documentID);
  const other = crypto.randomUUID();
  await db.sql`INSERT INTO agent_sessions (id, user_id, client_name, avatar_seed) VALUES (${other}, ${userID}, 'Claude Code', ${other})`;
  await db.sql`UPDATE notes SET claimed_by = ${other}, status = 'AgentWorking' WHERE id = ${noteID}`;
  const m = scriptedModel([{ text: "hi" }]);

  expect(await runNote(toolDeps(db), { documentID, noteID, userID, model: m.model })).toBe("claimed");
  expect(m.calls()).toBe(0);
  expect(await noteRow(noteID)).toMatchObject({ claimed_by: other });
});

test("without provider settings the run explains how to set it up; the server's own keys are never used", async () => {
  const userID = await createUser(db);
  const documentID = await newDoc(db, userID);
  const noteID = await newNote(db, userID, documentID);
  const deps = toolDeps(db);

  expect(await runNote(deps, { documentID, noteID, userID })).toBe("setup");
  expect((await thread(noteID)).at(-1)).toMatchObject({ kind: "message", builtin: true, text: "Set up the agent in Settings to hand notes to it." });

  const before = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-server-key";
  try {
    await saveAgentSettings(db, SECRET, userID, { provider: "anthropic", model: "claude-opus-5" });
    expect(await runNote(deps, { documentID, noteID, userID })).toBe("setup");
    expect((await thread(noteID)).at(-1)?.text).toBe("Add an API key for your agent's provider in Settings.");
  } finally {
    if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = before;
  }
  expect(await noteRow(noteID)).toMatchObject({ status: "Open", claimed_by: null });
});

test("taking the note back stops a run in progress", async () => {
  const userID = await createUser(db);
  const documentID = await newDoc(db, userID);
  const noteID = await newNote(db, userID, documentID);
  const m = scriptedModel([{ tool: "list_scripts", input: {} }]);
  const slow = m.model.doGenerate.bind(m.model);
  (m.model as any).doGenerate = async (o: any) => (await Bun.sleep(20), slow(o));

  const outcome = runNote(toolDeps(db), { documentID, noteID, userID, model: m.model, claimPollMs: 10 });
  while ((await noteRow(noteID)).claimed_by === null) await Bun.sleep(5);
  await run(db, mutators.note.release({ noteID }), { userID });

  expect(await outcome).toBe("taken-back");
  expect(await noteRow(noteID)).toMatchObject({ status: "Open", claimed_by: null });
  expect((await thread(noteID)).at(-1)).toMatchObject({ kind: "activity", text: "Stopped: the note was taken back.", builtin: true });
});

test("with AGENT_TRACE_DIR set, the run and its tool calls are traced in full", async () => {
  const { mkdtempSync, readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "ps-trace-"));
  process.env.AGENT_TRACE_DIR = dir;
  try {
    const userID = await createUser(db);
    const documentID = await newDoc(db, userID);
    const noteID = await newNote(db, userID, documentID);
    const m = scriptedModel([{ tool: "read_script", input: { path: "studios/missing.ts" } }, { tool: "set_note_status", input: { id: noteID, status: "Resolved" } }]);
    expect(await runNote(toolDeps(db), { documentID, noteID, userID, model: m.model })).toBe("resolved");

    const [day] = readdirSync(dir);
    const files = readdirSync(join(dir, day!));
    const lines = (f: string) => readFileSync(join(dir, day!, f), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const run = lines(files.find((f) => f.startsWith("run-") && f.includes(noteID))!);
    expect(run.map((e) => e.event)).toEqual(["start", "session", "prompt", "step", "step", "finished", "end"]);
    expect(run.find((e) => e.event === "prompt").prompt).toContain("Make it thicker");
    const failed = run[3].content.find((c: any) => c.type === "tool-result" || c.type === "tool-error");
    expect(JSON.stringify(failed)).toContain("studios/missing.ts");
    expect(run.at(-1)).toMatchObject({ event: "end", outcome: "resolved" });

    const tools = lines(files.find((f) => f.startsWith("tools-"))!);
    expect(tools.map((e) => e.tool)).toEqual(["claim_note", "get_note", "read_script", "set_note_status"]);
    expect(tools[2]).toMatchObject({ isError: true, args: { path: "studios/missing.ts", document: documentID } });
  } finally {
    delete process.env.AGENT_TRACE_DIR;
  }
});
