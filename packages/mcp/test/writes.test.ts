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
  mode: "ok" as "ok" | "problem" | "throw" | "slow",
  regenerated: [] as string[],
  assemblies: [] as unknown[],
  async run(job: { scripts: Record<string, string>; ops: { op: string; part?: string }[] }) {
    if (engine.mode === "throw") throw new EngineUnavailable("timed out");
    const studios = Object.keys(job.scripts).filter((p) => p.startsWith("studios/")).map((p) => p.slice(8, -3));
    if (job.ops.some((o) => o.op === "regenerate")) engine.regenerated = job.ops.map((o) => o.part!);
    return job.ops.map((o) => {
      if (o.op === "parts") return { ok: true, value: studios.map((id) => ({ id, file: `studios/${id}.ts` })) };
      if (o.op === "assemblies") return { ok: true, value: engine.assemblies };
      const problems = engine.mode === "problem" ? [{ severity: "error", kind: "operation", message: "fillet radius 5 exceeds adjacent face width 3.2; use a value below 3.2 (a.ts:18)", source: { file: "studios/a.ts", line: 18 }, highlight: { kind: "edge", names: Array(500).fill("x") } }] : [];
      return { ok: true, value: { part: o.part, name: o.part, ok: !problems.length, problems, faces: Array(200).fill({}), edges: Array(400).fill({}), bbox: { min: [0, 0, 0], max: [1, 1, 1] }, timings: engine.mode === "slow" ? { total: 4200, script: 4100, ops: 3900, opCount: 140, mesh: 60, slowest: [{ type: "intersect", tag: "slots", source: { file: "studios/a.ts", line: 12 }, ms: 1840 }, { type: "fillet", source: { file: "lib/size.ts", line: 3 }, ms: 610 }] } : { total: 1, ops: 1 }, params: [] } };
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

test("assembly problems reach list_problems and write reports, warnings included", async () => {
  engine.mode = "ok";
  const warning = { severity: "warning", kind: "runtime", message: 'studio "Rig" shows "Corner" twice: exported and inserted by "Cart". Export "Corner" from its own studio and import it here (rig.ts:5)', part: "rig:corner", source: { file: "studios/rig.ts", line: 5 } };
  engine.assemblies = [{ id: "rig:corner", file: "studios/rig.ts", export: "corner", name: "Corner", studio: "Rig", instances: [], subs: [], fixed: [], joints: [], relations: [], problems: [warning] }];
  try {
    const line = 'warning studios/rig.ts:5 studio "Rig" shows "Corner" twice: exported and inserted by "Cart". Export "Corner" from its own studio and import it here';
    const w = await claude.call("write_scripts", { files: [{ path: "studios/rig.ts", content: "export {};\n", baseVersion: null }] });
    expect(w.problems["rig:corner"]).toEqual([line]);
    const r = await claude.call("list_problems");
    expect(r.assemblies).toEqual({ "rig:corner": [line] });
    expect(r.introducedBy["studios/rig.ts"]).toContain("v");
  } finally {
    engine.assemblies = [];
  }
});

/** Set a script's content (whatever earlier tests left), returning its new version. */
async function put(path: string, content: string) {
  const { version } = await claude.call("read_script", { path });
  return (await claude.call("write_script", { path, content, baseVersion: version })).scripts[path] as number;
}

test("search_scripts finds usages as path:line lines, with context and limits", async () => {
  engine.mode = "ok";
  await put("lib/size.ts", "export const w = 10;\n");
  await put("studios/a.ts", "import { w } from '../lib/size';\nexport default w;\n");
  const r = await claude.call("search_scripts", { pattern: "\\bw\\b" });
  expect(r.matches).toContain("lib/size.ts:1: export const w = 10;");
  expect(r.matches.some((m: string) => m.startsWith("studios/a.ts:1: import { w }"))).toBe(true);
  expect(Object.keys(r.versions).sort()).toEqual(["lib/size.ts", "studios/a.ts"]);
  const lib = await claude.call("search_scripts", { pattern: "W", path: "lib/", ignoreCase: true });
  expect(lib.matches).toEqual(["lib/size.ts:1: export const w = 10;"]);
  const ctx = await claude.call("search_scripts", { pattern: "^import", context: 1 });
  expect(ctx.matches[0]).toBe("studios/a.ts:1: import { w } from '../lib/size';");
  expect(ctx.matches[1]).toStartWith("studios/a.ts:2- ");
  const capped = await claude.call("search_scripts", { pattern: "w", limit: 1 });
  expect(capped.matches.length).toBe(1);
  expect(capped.truncated).toContain(`of ${capped.count}`);
  const bad = await claude.raw("search_scripts", { pattern: "(" });
  expect(bad.isError).toBe(true);
  expect(bad.content[0]!.text).toStartWith("Invalid regular expression");
});

test("write results say where a slow regeneration spent its time", async () => {
  const version = await put("lib/size.ts", "export const w = 10;\n");
  engine.mode = "slow";
  const r = await claude.call("edit_script", { path: "lib/size.ts", edits: [{ search: "= 10", replace: "= 11" }], baseVersion: version });
  expect(r.slow.a).toBe('4.2 s (geometry 3.9 s in 140 operations); slowest: intersect "slots" at studios/a.ts:12 1840 ms, fillet at lib/size.ts:3 610 ms');
  const v = await claude.call("edit_script", { path: "lib/size.ts", edits: [{ search: "= 11", replace: "= 12" }], baseVersion: r.scripts["lib/size.ts"], verbose: true });
  expect(v.regeneration[0].timingsMs).toMatchObject({ total: 4200, ops: 3900, opsRun: 140, slowest: ['intersect "slots" at studios/a.ts:12 1840 ms', "fillet at lib/size.ts:3 610 ms"] });
  engine.mode = "ok";
});

test("editing one file that breaks files depending on it suggests write_scripts", async () => {
  engine.mode = "ok";
  const version = await put("lib/size.ts", "export const w = 12;\n");
  engine.mode = "problem";
  const r = await claude.call("edit_script", { path: "lib/size.ts", edits: [{ search: "= 12", replace: "= 13" }], baseVersion: version });
  expect(r.problems.a).toBeDefined();
  expect(r.hint).toContain("write_scripts");
  // the studio's own problem after editing that studio is no hint
  const { version: av } = await claude.call("read_script", { path: "studios/a.ts" });
  const own = await claude.call("edit_script", { path: "studios/a.ts", edits: [{ search: "export default w", replace: "export default w + 0" }], baseVersion: av });
  expect(own.hint).toBeUndefined();
  engine.mode = "ok";
});

test("a database connection that can't be opened is retried once, then reported plainly", async () => {
  let failures = 1;
  const flaky = new Proxy(db.sql, {
    apply(target, self, args) {
      if (failures-- > 0) return Promise.reject(Object.assign(new Error("write CONNECT_TIMEOUT postgres:5432"), { code: "CONNECT_TIMEOUT" }));
      return Reflect.apply(target as any, self, args);
    },
  });
  const session: Session = { id: claude.session.id, userID: claude.session.userID, clientID: "flaky", clientName: "flaky", defaultDocument: documentID, activeConfig: new Map(), lastVersion: new Map(), calls: [], noteCursors: new Map(), startedAt: Date.now() };
  const server = new McpServer({ name: "test", version: "1" });
  registerTools(server, session, { db: { ...db, sql: flaky } as any, pool: engine as any, store: new FsBlobStore(tmpdir()), noteEvents: createNoteEvents(db), config: { appOrigin: "http://localhost", secret: "test" } });
  const client = new Client({ name: "flaky", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  clients.push(client);
  const ok = (await client.callTool({ name: "read_script", arguments: { path: "lib/size.ts" } })) as any;
  expect(ok.isError).toBeFalsy();
  expect(JSON.parse(ok.content[0].text).path).toBe("lib/size.ts");
  failures = 2;
  const down = (await client.callTool({ name: "read_script", arguments: { path: "lib/size.ts" } })) as any;
  expect(down.isError).toBe(true);
  expect(down.content[0].text).toBe("The database didn't answer (CONNECT_TIMEOUT); nothing was changed. Retry shortly.");
});
