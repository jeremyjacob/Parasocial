// check's clearance option: non-interfering pairs closer than it, top level and per assembly at
// the session pose. Needs the test Postgres (packages/sync/README.md); the engine pool is faked.
import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadKernel } from "@parasocial/kernel";
import { FakePool } from "./fake-pool";
import { mutators } from "@parasocial/sync";
import { FsBlobStore } from "@parasocial/sync/server";
import { createTestDb, createUser, createAgentSession, newDoc, run } from "../../sync/test/helpers";
import { createNoteEvents } from "../src/note-events";
import { registerTools, type Session } from "../src/tools";

const root = join(import.meta.dir, "../../../examples/hinge");
const SCRIPTS = { "studios/box.ts": readFileSync(join(root, "studios/box.ts"), "utf8"), "studios/mechanism.ts": readFileSync(join(root, "studios/mechanism.ts"), "utf8") };

beforeAll(async () => {
  await loadKernel();
});

test("check clearance lists near pairs, closest first, with the part filter", async () => {
  const db = await createTestDb();
  const userID = await createUser(db);
  const doc = await newDoc(db, userID, "Hinge");
  for (const [path, content] of Object.entries(SCRIPTS)) await run(db, mutators.script.write({ documentID: doc, path, content, baseVersion: null }), { userID });
  const session: Session = { id: await createAgentSession(db, userID, "Claude"), userID, clientID: "c", clientName: "Claude", defaultDocument: doc, activeConfig: new Map(), lastVersion: new Map(), calls: [], noteCursors: new Map(), startedAt: Date.now() };
  const server = new McpServer({ name: "test", version: "1" });
  const client = new Client({ name: "c", version: "1" });
  registerTools(server, session, { db, pool: new FakePool() as any, store: new FsBlobStore(tmpdir()), noteEvents: createNoteEvents(db), config: { appOrigin: "http://localhost", secret: "test" } });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name: tool, arguments: args });
    const t = (r.content as { type: string; text?: string }[])[0];
    if (r.isError) throw new Error(t?.text);
    return JSON.parse(t.text!);
  };
  try {
    const plain = await call("check");
    expect(plain.near).toBeUndefined();
    expect(plain.assemblies[0].near).toBeUndefined();
    // closed box: lid and drawer touch the body (distance 0), not each other
    const near = await call("check", { clearance: 5 });
    expect(near.interference).toEqual([]);
    expect(near.near.map((x: any) => [x.a, x.b, x.distance])).toEqual([["box", "box:lid", 0], ["box", "box:drawer", 0]]);
    expect(near.near[0].points).toEqual([[-35, -25, 40], [-35, -25, 40]]);
    expect(near.assemblies[0].near.map((x: any) => [x.a, x.b, x.distance])).toEqual([["mechanism/box", "mechanism/box:lid", 0], ["mechanism/box", "mechanism/box:drawer", 0]]);
    const lid = await call("check", { part: "box:lid", clearance: 5 });
    expect(lid.near.map((x: any) => x.b)).toEqual(["box:lid"]);
    expect(lid.assemblies[0].near.map((x: any) => x.b)).toEqual(["mechanism/box:lid"]);
    // drawer slid out at the session pose: it rides 0.4 mm off the body
    await call("set_pose", { assembly: "mechanism", joints: { drawer: 20 } });
    const open = await call("check", { part: "mechanism/box:drawer", clearance: 1 });
    expect(open.assemblies[0].near).toEqual([{ a: "mechanism/box", b: "mechanism/box:drawer", distance: 0.4, points: [[31.1, 1.1, 13], [31.1, 1.1, 12.6]] }]);
    expect((await call("check", { part: "mechanism/box:drawer", clearance: 0.3 })).assemblies[0].near).toEqual([]);
  } finally {
    await client.close();
    await server.close();
  }
});
