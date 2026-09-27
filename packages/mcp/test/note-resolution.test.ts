import { expect, test } from "bun:test";
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
