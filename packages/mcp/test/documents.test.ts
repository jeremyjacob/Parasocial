import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PoolClient } from "@parasocial/engine-pool/client";
import { mutators } from "@parasocial/sync";
import { FsBlobStore } from "@parasocial/sync/server";
import { tmpdir } from "node:os";
import { createTestDb, createUser, createAgentSession, newDoc, run } from "../../sync/test/helpers";
import { createNoteEvents } from "../src/note-events";
import { documentContext } from "../src/document-context";
import { registerTools, type Session } from "../src/tools";

test("browser context is personal, deduplicated, freshness-labelled and membership checked", async () => {
  const db = await createTestDb();
  try {
    const userID = await createUser(db);
    const other = await createUser(db, "Other");
    const current = await newDoc(db, userID, "Current");
    const old = await newDoc(db, userID, "Old");
    const agentOnly = await newDoc(db, userID, "Agent only");
    const otherOnly = await newDoc(db, other, "Other browser");
    const revoked = await newDoc(db, other, "Revoked");
    const agentSessionID = await createAgentSession(db, userID);
    const now = Date.now();
    for (const [doc, viewer, agent, at] of [
      [current, userID, null, now], [current, userID, null, now - 1000],
      [old, userID, null, now - 120_000], [agentOnly, userID, agentSessionID, now],
      [otherOnly, other, null, now], [revoked, userID, null, now],
    ] as const) {
      await db.sql`INSERT INTO presence (id, document_id, user_id, agent_session_id, selection, updated_at)
        VALUES (${crypto.randomUUID()}, ${doc}, ${viewer}, ${agent}, '[]', ${at})`;
    }
    const context = await documentContext(db, userID, "http://localhost");
    expect(context.recentBrowserDocuments).toEqual([
      { id: current, name: "Current", url: `http://localhost/d/${current}`, lastSeenAt: new Date(now).toISOString(), recentlyActive: true },
      { id: old, name: "Old", url: `http://localhost/d/${old}`, lastSeenAt: new Date(now - 120_000).toISOString(), recentlyActive: false },
    ]);
  } finally {
    await db.drop();
  }
});

test("document tools discover, select and manage documents with shared permissions", async () => {
  const db = await createTestDb();
  const server = new McpServer({ name: "test", version: "1" });
  const client = new Client({ name: "test", version: "1" });
  try {
    const userID = await createUser(db);
    const other = await createUser(db, "Other");
    const owned = await newDoc(db, userID, "Bracket");
    const viewOnly = await newDoc(db, other, "Bracket shared");
    const secret = await newDoc(db, other, "Private");
    await db.sql`INSERT INTO document_members (document_id, user_id, role, created_at) VALUES (${viewOnly}, ${userID}, 'viewer', ${Date.now()})`;
    await run(db, mutators.script.write({ documentID: owned, path: "studios/main.ts", content: "export default 1;", baseVersion: null }), { userID });
    const session: Session = {
      id: await createAgentSession(db, userID), userID, clientID: "test", clientName: "test",
      activeConfig: new Map(), lastVersion: new Map(), calls: [], noteCursors: new Map(), startedAt: Date.now(),
    };
    registerTools(server, session, {
      db, pool: new PoolClient(), store: new FsBlobStore(tmpdir()), noteEvents: createNoteEvents(db),
      config: { appOrigin: "http://localhost", secret: "test" },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      return JSON.parse((result.content as { text: string }[])[0]!.text);
    };
    const denied = async (name: string, args: Record<string, unknown>) => {
      expect((await client.callTool({ name, arguments: args })).isError).toBe(true);
    };

    const found = await call("list_documents", { query: "BRACKET", limit: 1 });
    expect(found.documents).toHaveLength(1);
    expect(found.nextOffset).toBe(1);
    const next = await call("list_documents", { query: "bracket", limit: 1, offset: found.nextOffset });
    expect(next.documents[0].id).not.toBe(found.documents[0].id);
    expect(next.nextOffset).toBeNull();
    expect((await call("list_documents", { query: "Private" })).documents).toEqual([]);
    expect((await call("get_document_context")).recentBrowserDocuments).toEqual([]);
    expect(session.defaultDocument).toBeUndefined();
    await denied("list_scripts", {});

    expect(await call("open_document", { document: `http://localhost/d/${owned}` })).toMatchObject({ id: owned, scripts: ["studios/main.ts"] });
    expect(session.defaultDocument).toBe(owned);
    expect((await call("list_scripts")).scripts).toHaveLength(1);
    await denied("open_document", { document: secret });
    await denied("open_document", { document: `https://elsewhere.example/d/${owned}` });
    expect(session.defaultDocument).toBe(owned);
    await call("rename_document", { name: "Renamed" });
    expect((await db.sql`SELECT name FROM documents WHERE id = ${owned}`)[0]!.name).toBe("Renamed");
    await denied("rename_document", { document: viewOnly, name: "No" });
    await denied("delete_document", { document: viewOnly });
    await denied("delete_document", {});

    const copy = await call("duplicate_document");
    expect(copy.name).toBe("Renamed (copy)");
    expect(session.defaultDocument).toBe(owned);
    expect((await db.sql`SELECT content FROM scripts WHERE document_id = ${copy.id}`)[0]!.content).toBe("export default 1;");
    expect((await db.sql`SELECT owner_id FROM documents WHERE id = ${copy.id}`)[0]!.owner_id).toBe(userID);
    await denied("duplicate_document", { document: secret });
    await call("open_document", { document: copy.id });
    session.activeConfig.set(copy.id, "old-config");
    await call("delete_document", { document: copy.id });
    expect(session.defaultDocument).toBeUndefined();
    expect(session.activeConfig.has(copy.id)).toBe(false);
    expect(await db.sql`SELECT id FROM documents WHERE id = ${copy.id}`).toHaveLength(0);
    const created = await call("create_document", { name: " New design " });
    expect(created.name).toBe("New design");
    expect(session.defaultDocument).toBe(created.id);
    const archive = await call("export_document", { document: owned, base64: true });
    const imported = await call("import_document", { zip: archive.base64, name: "Imported" });
    expect(imported.url).toBe(`http://localhost/d/${imported.id}`);
    expect(session.defaultDocument).toBe(created.id);
  } finally {
    await client.close();
    await server.close();
    await db.drop();
  }
}, 30_000);
