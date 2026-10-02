import { expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PoolClient } from "@parasocial/engine-pool/client";
import { mutators, sha256Hex } from "@parasocial/sync";
import { FsBlobStore } from "@parasocial/sync/server";
import { tmpdir } from "node:os";
import { createTestDb, createUser, createAgentSession, newDoc, run } from "../../sync/test/helpers";
import { createNoteEvents } from "../src/note-events";
import { registerTools } from "../src/tools";

test("MCP resolves silently or with an optional reply; unfinished work stays open", async () => {
  const db = await createTestDb();
  const server = new McpServer({ name: "test", version: "1" });
  const client = new Client({ name: "test", version: "1" });
  try {
    const userID = await createUser(db);
    const documentID = await newDoc(db, userID);
    const agentID = await createAgentSession(db, userID);
    const noteID = crypto.randomUUID();
    const snapshot = await sha256Hex("snapshot");
    await db.sql`INSERT INTO blobs (hash, size, content_type) VALUES (${snapshot}, 8, 'image/png')`;
    await run(db, mutators.note.create({
      id: noteID, documentID, text: "Make it thicker",
      anchor: {
        targets: [{ kind: "point", name: "point", point: [0, 0, 0] }],
        camera: { position: [10, 10, 10], target: [0, 0, 0], up: [0, 0, 1], fov: 45, ortho: false },
        version: "v1", configuration: "Default", snapshot,
      },
    }), { userID });
    registerTools(server, {
      id: agentID, userID, clientID: "test", clientName: "test", defaultDocument: documentID,
      activeConfig: new Map(), lastVersion: new Map(), calls: [], noteCursors: new Map(), startedAt: Date.now(),
    }, {
      db, pool: new PoolClient(), store: new FsBlobStore(tmpdir()), noteEvents: createNoteEvents(db),
      config: { appOrigin: "http://localhost", secret: "test" },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: { id: noteID, ...args } });
      expect(result.isError).not.toBe(true);
      const content = result.content as { type: string; text: string }[];
      return JSON.parse(content.find((c) => c.type === "text")!.text);
    };
    const note = async () => (await db.sql`SELECT status, claimed_by FROM notes WHERE id = ${noteID}`)[0];

    await call("claim_note");
    await call("set_note_status", { status: "Resolved" });
    expect(await note()).toMatchObject({ status: "Resolved", claimed_by: null });
    const messages = await db.sql`SELECT text FROM note_messages WHERE note_id = ${noteID}`;
    expect(messages.map((m) => m.text)).toEqual(["Make it thicker"]);
    expect((await db.sql`SELECT status FROM agent_sessions WHERE id = ${agentID}`)[0]?.status).toBe("idle");

    await run(db, mutators.note.reply({ id: crypto.randomUUID(), noteID, text: "A little more" }), { userID });
    expect(await note()).toMatchObject({ status: "Open" });

    for (const status of [undefined, "Open", "Resolved"]) {
      await call("claim_note");
      const result = await call("reply_to_note", { text: "Useful detail", ...(status ? { status } : {}) });
      expect(result.status).toBe(status ?? "Resolved");
      expect(await note()).toMatchObject({ status: status ?? "Resolved", claimed_by: null });
    }
  } finally {
    await client.close();
    await server.close();
    await db.drop();
  }
}, 30_000);

test("studio notes persist, filter and resolve without geometry, including after studio deletion", async () => {
  const db = await createTestDb();
  const server = new McpServer({ name: "test", version: "1" });
  const client = new Client({ name: "test", version: "1" });
  const pool = new PoolClient();
  const engine = spyOn(pool, "run").mockRejectedValue(new Error("Studio targets must not use geometry resolution"));
  try {
    const userID = await createUser(db);
    const documentID = await newDoc(db, userID);
    const agentID = await createAgentSession(db, userID);
    const studio = "studios/model.ts";
    await run(db, mutators.script.write({ documentID, path: studio, content: "export const rear = {}; export const front = {};", baseVersion: null }), { userID });
    const id = crypto.randomUUID();
    const snapshot = await sha256Hex("studio snapshot");
    await db.sql`INSERT INTO blobs (hash, size, content_type) VALUES (${snapshot}, 15, 'image/png')`;
    const anchor = {
      targets: [{ kind: "studio" as const, studio, name: "Model", point: [5, 10, 15] as [number, number, number] }],
      camera: { position: [10, 10, 10] as [number, number, number], target: [0, 0, 0] as [number, number, number], up: [0, 0, 1] as [number, number, number], fov: 45, ortho: false },
      version: "v1", configuration: "Default", snapshot,
    };
    await run(db, mutators.note.create({ id, documentID, text: "Simplify this studio", anchor }), { userID });
    expect((await db.sql`SELECT anchor FROM notes WHERE id = ${id}`)[0].anchor.targets).toEqual(anchor.targets);
    registerTools(server, {
      id: agentID, userID, clientID: "test", clientName: "test", defaultDocument: documentID,
      activeConfig: new Map(), lastVersion: new Map(), calls: [], noteCursors: new Map(), startedAt: Date.now(),
    }, { db, pool, store: new FsBlobStore(tmpdir()), noteEvents: createNoteEvents(db), config: { appOrigin: "http://localhost", secret: "test" } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      return JSON.parse((result.content as { type: string; text: string }[]).find((c) => c.type === "text")!.text);
    };
    expect((await call("get_note", { id })).targets).toEqual([{ ...anchor.targets[0], status: "name" }]);
    expect((await call("list_notes", { studio })).notes.map((n: any) => n.id)).toEqual([id]);
    expect((await call("list_notes", { studio: "studios/other.ts" })).notes).toEqual([]);
    expect((await call("list_notes", { part: "model:rear" })).notes).toEqual([]);

    // Bulk note loading must keep each thread, markup and document ordinal together.
    const extraIDs: string[] = [];
    for (let i = 0; i < 6; i++) {
      const noteID = crypto.randomUUID();
      extraIDs.push(noteID);
      await run(db, mutators.note.create({ id: noteID, documentID, text: `Thread ${i}`, anchor }), { userID });
      await run(db, mutators.note.reply({ id: crypto.randomUUID(), noteID, text: `Reply ${i}` }), { userID });
      await run(db, mutators.markup.add({ id: crypto.randomUUID(), documentID, noteID, part: "model:rear", points: [[i, 0, 0], [i, 1, 0]], color: "#ff0000" }), { userID });
    }
    const listed = (await call("list_notes", { studio })).notes;
    expect(listed).toHaveLength(7);
    for (const [i, noteID] of extraIDs.entries()) {
      const n = listed.find((n: any) => n.id === noteID);
      expect(n.number).toBe(i + 2);
      expect(n.messages.map((m: any) => m.text)).toEqual([`Thread ${i}`, `Reply ${i}`]);
      expect(n.markup).toEqual([{ part: "model:rear", color: "#ff0000", points: 2, from: [i, 0, 0], to: [i, 1, 0] }]);
    }

    await run(db, mutators.script.write({ documentID, path: studio, content: "export const replacement = {};", baseVersion: 1 }), { userID });
    expect((await call("get_note", { id })).targets[0]).toMatchObject({ studio, status: "name" });
    await run(db, mutators.script.delete({ documentID, path: studio, baseVersion: 2 }), { userID });
    expect((await call("get_note", { id })).targets[0]).toMatchObject({ studio, status: "orphaned" });
    await run(db, mutators.script.write({ documentID, path: studio, content: "export default {};", baseVersion: null }), { userID });
    expect((await call("get_note", { id })).targets[0]).toMatchObject({ studio, status: "name" });

    const { snapshot: _, ...withoutSnapshot } = anchor;
    await run(db, mutators.note.reanchor({ noteID: id, anchor: { ...withoutSnapshot, targets: [{ ...anchor.targets[0], point: [1, 2, 3] }] } }), { userID });
    expect((await call("get_note", { id })).targets[0].point).toEqual([1, 2, 3]);
    expect(engine).not.toHaveBeenCalled();
  } finally {
    engine.mockRestore();
    await client.close();
    await server.close();
    await db.drop();
  }
}, 30_000);
