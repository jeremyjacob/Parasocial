// evaluate: an expression in a script module's scope, run by the engine (faked in-process), with
// this session's param previews when a part is given. Needs the test Postgres (packages/sync/README.md).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadKernel } from "@parasocial/kernel";
import { mutators } from "@parasocial/sync";
import { FsBlobStore } from "@parasocial/sync/server";
import { FakePool } from "./fake-pool";
import { createTestDb, createUser, createAgentSession, newDoc, run, type TestDb } from "../../sync/test/helpers";
import { createNoteEvents } from "../src/note-events";
import { registerTools, type Session } from "../src/tools";

const SCRIPTS = {
  "lib/winch.ts": `import { param, box, mm } from "parasocial";
const plate = 4;
export function winch() {
  const travel = param("travel", 120, { unit: mm });
  return { drumFront: plate + 20.123456789, travel, drum: box(10, 20, 30) };
}
`,
  "studios/pedestal.ts": `import { part } from "parasocial";\nimport { winch } from "../lib/winch";\nexport default part("Pedestal", () => winch().drum);\n`,
};

let db: TestDb;
let client: Client;
let call: (tool: string, args?: Record<string, unknown>) => Promise<any>;

beforeAll(async () => {
  await loadKernel();
  db = await createTestDb();
  const userID = await createUser(db);
  const doc = await newDoc(db, userID, "Winch");
  for (const [path, content] of Object.entries(SCRIPTS)) await run(db, mutators.script.write({ documentID: doc, path, content, baseVersion: null }), { userID });
  const session: Session = { id: await createAgentSession(db, userID, "Claude"), userID, clientID: "Claude", clientName: "Claude", defaultDocument: doc, activeConfig: new Map(), lastVersion: new Map(), calls: [], noteCursors: new Map(), startedAt: Date.now() };
  const server = new McpServer({ name: "test", version: "1" });
  client = new Client({ name: "Claude", version: "1" });
  registerTools(server, session, { db, pool: new FakePool() as any, store: new FsBlobStore(tmpdir()), noteEvents: createNoteEvents(db), config: { appOrigin: "http://localhost", secret: "test" } });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  call = async (tool, args = {}) => {
    const r = await client.callTool({ name: tool, arguments: args });
    const t = (r.content as { text: string }[])[0]!.text;
    if (r.isError) throw new Error(t);
    return JSON.parse(t);
  };
});
afterAll(async () => {
  await client?.close();
  await db?.drop();
});

test("evaluate returns computed values, summarized geometry and the params it read", async () => {
  expect(await call("evaluate", { script: "lib/winch.ts", expr: "winch()" })).toEqual({ value: { drumFront: 24.1235, travel: 120, drum: { type: "Solid", bbox: { min: [0, 0, 0], max: [10, 20, 30], size: [10, 20, 30] } } }, params: { travel: 120 } });
  expect((await call("evaluate", { script: "lib/winch.ts", expr: "plate * 2" })).value).toBe(8);
});

test("evaluate with a part reads that part's params, session previews included", async () => {
  await call("set_param", { part: "pedestal", name: "travel", value: 200 });
  expect((await call("evaluate", { script: "lib/winch.ts", expr: "winch().travel", part: "pedestal" })).value).toBe(200);
  expect((await call("evaluate", { script: "lib/winch.ts", expr: "winch().travel" })).value).toBe(120);
});

test("evaluate errors name the line", async () => {
  await expect(call("evaluate", { script: "lib/winch.ts", expr: "missing()" })).rejects.toThrow(/missing is not defined \(expr:1\)/);
  await expect(call("evaluate", { script: "lib/nope.ts", expr: "1" })).rejects.toThrow(/No script at lib\/nope\.ts/);
});
