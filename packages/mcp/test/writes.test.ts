// Script-writing tools with two agents on one document: compact results, atomic multi-file
// writes, retry safety, post-commit regeneration failures, and awareness of each other.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FsBlobStore } from "@parasocial/sync/server";
import { tmpdir } from "node:os";
import { createTestDb, createUser, createAgentSession, newDoc, type TestDb } from "../../sync/test/helpers";
import { createNoteEvents } from "../src/note-events";
import { registerTools, type Session } from "../src/tools";
import { EngineUnavailable, PoolClient } from "@parasocial/engine-pool/client";

/** A stand-in engine pool: one part per studio; `mode` makes regeneration report a problem or blow up. `regenerated`: the parts the last job regenerated. */
const engine = {
  mode: "ok" as "ok" | "problem" | "throw",
  regenerated: [] as string[],
  async run(job: { scripts: Record<string, string>; ops: { op: string; part?: string }[] }) {
    if (engine.mode === "throw") throw new EngineUnavailable("timed out");
    const studios = Object.keys(job.scripts).filter((p) => p.startsWith("studios/")).map((p) => p.slice(8, -3));
    if (job.ops.some((o) => o.op === "regenerate")) engine.regenerated = job.ops.map((o) => o.part!);
    return job.ops.map((o) => {
      if (o.op === "parts") return { ok: true, value: studios.map((id) => ({ id, file: `studios/${id}.ts` })) };
      if (o.op === "assemblies") return { ok: true, value: [] };
      const problems = engine.mode === "problem" ? [{ severity: "error", kind: "operation", message: "fillet radius 5 exceeds adjacent face width 3.2; use a value below 3.2 (a.ts:18)", source: { file: "studios/a.ts", line: 18 }, highlight: { kind: "edge", names: Array(500).fill("x") } }] : [];
      return { ok: true, value: { part: o.part, name: o.part, ok: !problems.length, problems, faces: Array(200).fill({}), edges: Array(400).fill({}), bbox: { min: [0, 0, 0], max: [1, 1, 1] }, timings: { total: 1, ops: 1 }, params: [] } };
    });
  },
};

let db: TestDb;
let documentID: string;
const clients: Client[] = [];
const sessions: Session[] = [];

async function connect(userID: string, clientName: string, pool: unknown = engine) {
  const session: Session = {
    id: await createAgentSession(db, userID, clientName), userID, clientID: clientName, clientName, defaultDocument: documentID,
    activeConfig: new Map(), lastVersion: new Map(), calls: [], noteCursors: new Map(), startedAt: Date.now(),
  };
  const server = new McpServer({ name: "test", version: "1" });
  registerTools(server, session, { db, pool: pool as any, store: new FsBlobStore(tmpdir()), noteEvents: createNoteEvents(db), config: { appOrigin: "http://localhost", secret: "test" } });
  const client = new Client({ name: clientName, version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  clients.push(client);
  sessions.push(session);
  const raw = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<{ isError?: boolean; content: { text: string }[] }>;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await raw(name, args);
    if (r.isError) throw new Error(r.content[0]!.text);
    return { ...JSON.parse(r.content[0]!.text), _chars: r.content[0]!.text.length };
  };
  return { session, call, raw };
}

let claude: Awaited<ReturnType<typeof connect>>;
let codex: Awaited<ReturnType<typeof connect>>;

beforeAll(async () => {
  db = await createTestDb();
  const userID = await createUser(db);
  documentID = await newDoc(db, userID);
  claude = await connect(userID, "Claude Code");
  codex = await connect(userID, "Codex");
});
afterAll(async () => {
  for (const c of clients) await c.close();
  await db.drop();
});

test("write_scripts lands a lib change and its studio as one version with a compact result", async () => {
  engine.mode = "ok";
  const created = await claude.call("write_scripts", {
    files: [
      { path: "lib/size.ts", content: "export const w = 10;\n", baseVersion: null },
      { path: "studios/a.ts", content: "import { w } from '../lib/size';\nexport default w;\n", baseVersion: null },
    ],
  });
  expect(created.version.number).toBe(1);
  expect(created.scripts).toEqual({ "lib/size.ts": 1, "studios/a.ts": 1 });
  expect(created.parts).toEqual({ regenerated: 1, ok: 1 });
  expect(created.problems).toBeUndefined();
  expect(created.regeneration).toBeUndefined();
  expect(claude.session.lastVersion.get(documentID)).toBe(created.version.id);

  const stale = await claude.raw("write_scripts", {
    files: [
      { path: "lib/size.ts", content: "export const width = 10;\n", baseVersion: 1 },
      { path: "studios/a.ts", edits: [{ search: "{ w }", replace: "{ width as w }" }], baseVersion: 0 },
    ],
  });
  expect(stale.isError).toBe(true);
  expect(stale.content[0]!.text).toContain("studios/a.ts changed since version 0");
  expect(stale.content[0]!.text).toContain("baseVersion is this script's own version");
  expect((await claude.call("read_script", { path: "lib/size.ts" })).content).toBe("export const w = 10;\n");
});

test("problems come back as file:line lines; verbose returns the full result", async () => {
  engine.mode = "problem";
  const r = await claude.call("edit_script", { path: "studios/a.ts", edits: [{ search: "export default w", replace: "export default w * 2" }], baseVersion: 1 });
  expect(r.parts).toEqual({ regenerated: 1, ok: 0 });
  expect(r.problems).toEqual({ a: ["error studios/a.ts:18 fillet radius 5 exceeds adjacent face width 3.2; use a value below 3.2"] });
  expect(r._chars).toBeLessThan(400);
  const v = await claude.call("edit_script", { path: "studios/a.ts", edits: [{ search: "w * 2", replace: "w * 3" }], baseVersion: r.scripts["studios/a.ts"], verbose: true });
  expect(v.regeneration[0]).toMatchObject({ part: "a", faces: 200, edges: 400 });
  expect(v._chars).toBeGreaterThan(r._chars);
});

test("a regeneration failure after the commit is a normal result, and the write is safe to retry", async () => {
  engine.mode = "throw";
  const { version: base } = await claude.call("read_script", { path: "studios/a.ts" });
  const args = { path: "studios/a.ts", content: "import { w } from '../lib/size';\nexport default w + 1;\n", baseVersion: base };
  const r = await claude.call("write_script", args);
  expect(r.ok).toBe(true);
  expect(r.version.number).toBe(base + 1);
  expect(r.regenerationFailed).toStartWith("geometry engine unavailable (timed out): retry shortly");
  expect(r.regenerationFailed).toContain(`The write is committed (version ${base + 1})`);
  engine.mode = "ok";
  // the agent never saw the result and retries the same call: success, nothing new written
  const again = await claude.call("write_script", args);
  expect(again).toMatchObject({ ok: true, version: null, scripts: { "studios/a.ts": base + 1 } });
  // retrying with the same writeId reports the original version
  const writeId = crypto.randomUUID();
  const e1 = await claude.call("edit_script", { path: "studios/a.ts", edits: [{ search: "w + 1", replace: "w + 2" }], baseVersion: base + 1, writeId });
  const e2 = await claude.call("edit_script", { path: "studios/a.ts", edits: [{ search: "w + 1", replace: "w + 2" }], baseVersion: base + 1, writeId });
  expect(e2.version).toEqual(e1.version);
  const [{ n }] = await db.sql`SELECT count(*)::int AS n FROM versions WHERE document_id = ${documentID}`;
  expect(n).toBe(e1.version.number);
});

test("agents see each other: recent editors, and lib files changed under them", async () => {
  engine.mode = "ok";
  const lib = await claude.call("read_script", { path: "lib/size.ts" });
  await codex.call("read_script", { path: "lib/size.ts" });
  const studio = await claude.call("read_script", { path: "studios/a.ts" });
  expect(studio.otherSessions).toBeUndefined();
  const edited = await codex.call("edit_script", { path: "lib/size.ts", edits: [{ search: "w = 10", replace: "w = 12" }], baseVersion: lib.version });
  // Claude created the lib earlier in this file, so it shows as a recent editor
  expect(edited.otherSessions["lib/size.ts"]).toEqual([{ who: "Claude Code", did: "edited", when: expect.stringContaining("ago") }]);

  // Claude edits the studio that imports the lib Codex just changed
  const w = await claude.call("edit_script", { path: "studios/a.ts", edits: [{ search: "export default", replace: "export default /* bigger */" }], baseVersion: studio.version });
  expect(w.changedByOthers).toEqual([{ path: "lib/size.ts", youSaw: lib.version, now: edited.scripts["lib/size.ts"], by: "Codex", importedBy: ["studios/a.ts"] }]);
  const reread = await claude.call("read_script", { path: "lib/size.ts" });
  expect(reread.otherSessions).toEqual([{ who: "Codex", did: "edited", when: expect.stringContaining("ago") }]);
  // once re-read, it is no longer flagged
  const w2 = await claude.call("edit_script", { path: "studios/a.ts", edits: [{ search: "/* bigger */", replace: "" }], baseVersion: w.scripts["studios/a.ts"] });
  expect(w2.changedByOthers).toBeUndefined();
});

test("a write regenerates only the parts it reaches: its studio, or studios importing it", async () => {
  engine.mode = "ok";
  const b = await claude.call("write_script", { path: "studios/b.ts", content: "export default 1;\n", baseVersion: null });
  expect(engine.regenerated).toEqual(["b"]);
  expect(b.parts).toEqual({ regenerated: 1, ok: 1, unaffected: 1 });
  const lib = await claude.call("read_script", { path: "lib/size.ts" });
  await claude.call("edit_script", { path: "lib/size.ts", edits: [{ search: "w = 12", replace: "w = 14" }], baseVersion: lib.version });
  expect(engine.regenerated).toEqual(["a"]);
  // verbose: every part, full results
  const v = await claude.call("edit_script", { path: "studios/b.ts", edits: [{ search: "1", replace: "2" }], baseVersion: b.scripts["studios/b.ts"], verbose: true });
  expect(engine.regenerated).toEqual(["a", "b"]);
  expect(v.regeneration).toHaveLength(2);
});

test("imports of files that don't exist are problems; creating the file regenerates its importers", async () => {
  engine.mode = "ok";
  const c = await claude.call("write_script", { path: "studios/c.ts", content: 'import frame from "./frame";\n// import old from "./gone";\nexport default frame;\n', baseVersion: null });
  expect(c.problems).toEqual({ "studios/c.ts": ["warning studios/c.ts imports studios/frame.ts, which doesn't exist"] });
  const f = await claude.call("write_script", { path: "studios/frame.ts", content: "export default 1;\n", baseVersion: null });
  expect(engine.regenerated.sort()).toEqual(["c", "frame"]);
  expect(f.problems).toBeUndefined();
});

test("a stale baseVersion says what changed since, not the whole file", async () => {
  engine.mode = "ok";
  const body = Array.from({ length: 200 }, (_, i) => `const line${i} = ${i}; // ${"padding ".repeat(6)}`).join("\n");
  const d = await claude.call("write_script", { path: "studios/d.ts", content: `${body}\nexport default 1;\n`, baseVersion: null });
  const base = d.scripts["studios/d.ts"];
  await codex.call("edit_script", { path: "studios/d.ts", edits: [{ search: "const line50 = 50;", replace: "const line50 = 51;" }], baseVersion: base });
  const r = await claude.raw("edit_script", { path: "studios/d.ts", edits: [{ search: "export default 1", replace: "export default 2" }], baseVersion: base });
  expect(r.isError).toBe(true);
  const t = r.content[0]!.text;
  expect(t).toContain(`studios/d.ts changed since version ${base} (now ${base + 1})`);
  expect(t).toContain(`@@ -51,1 +51,1 @@\n-const line50 = 50;`);
  expect(t).toContain("+const line50 = 51;");
  expect(t).not.toContain("line120");
  expect(t.length).toBeLessThan(800);
  expect(JSON.parse(t.slice(t.lastIndexOf("\n{")))).toEqual({ code: "stale", path: "studios/d.ts", baseVersion: base, current: { version: base + 1, lines: 202 } });
});

test("an engine pool that's down is a clear error, separate from part problems; engine_status reports it", async () => {
  const stub = Bun.serve({
    port: 0,
    fetch: (req) => (new URL(req.url).pathname === "/health" ? Response.json({ ok: true, documents: 2, build: "abc123" }) : new Response("<html>Bad Gateway</html>", { status: 502 })),
  });
  try {
    const userID = claude.session.userID;
    const proxied = await connect(userID, "Proxied", new PoolClient(`http://127.0.0.1:${stub.port}`));
    const r = await proxied.raw("list_problems");
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe("geometry engine unavailable (HTTP 502, not JSON: <html>Bad Gateway</html>): retry shortly; this is not a problem with your request");
    expect(await proxied.call("engine_status")).toMatchObject({ reachable: true, documents: 2, build: "abc123" });
    const down = await connect(userID, "Down", new PoolClient("http://127.0.0.1:1"));
    expect((await down.raw("list_problems")).content[0]!.text).toStartWith("geometry engine unavailable (unreachable: ");
    expect(await down.call("engine_status")).toMatchObject({ reachable: false });
  } finally {
    stub.stop(true);
  }
});

test("export_document returns a download URL unless base64 is asked for", async () => {
  const r = await claude.call("export_document", {});
  expect(r.url).toStartWith("http://localhost/api/blobs/");
  expect(r.base64).toBeUndefined();
  expect(r.bytes).toBeGreaterThan(0);
  const inline = await claude.call("export_document", { base64: true });
  expect(typeof inline.base64).toBe("string");
});
