// What each common tool call costs an agent's context: the characters of its text result on a
// real example (examples/stage: five parts, standard content, an assembly), with budgets so
// outputs stay lean. Needs the test Postgres (packages/sync/README.md); the engine pool is the
// runtime engine in-process (fake-pool.ts). RESPONSE_SIZES=1 prints the table.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadKernel } from "@parasocial/kernel";
import { mutators } from "@parasocial/sync";
import { FsBlobStore } from "@parasocial/sync/server";
import { createTestDb, createUser, createAgentSession, newDoc, run, type TestDb } from "../../sync/test/helpers";
import { createNoteEvents } from "../src/note-events";
import { registerTools, type Session } from "../src/tools";
import { registerApiReference } from "../src/api-reference";
import { FakePool } from "./fake-pool";
import { parseListing } from "./listing";

const example = join(import.meta.dir, "../../../examples/stage");
const SCRIPTS = Object.fromEntries(readdirSync(join(example, "studios")).map((f) => [`studios/${f}`, readFileSync(join(example, "studios", f), "utf8")]));

let db: TestDb;
let client: Client;
let doc: string;
const pool = new FakePool();
const sizes: Record<string, number> = {};
const pretty: string[] = [];

type Result = { isError?: boolean; content: { type: string; text?: string; data?: string }[] };
async function call(name: string, args: Record<string, unknown> = {}, label = name) {
  const r = (await client.callTool({ name, arguments: args })) as Result;
  const text = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  if (r.isError) throw new Error(`${name}: ${text}`);
  sizes[label] = text.length;
  if (/^[{[]\n/.test(text)) pretty.push(label);
  if (process.env.RESPONSE_DUMP) writeFileSync(join(process.env.RESPONSE_DUMP, `${label.replace(/[^\w]+/g, "_")}.txt`), text);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

beforeAll(async () => {
  await loadKernel();
  db = await createTestDb();
  const userID = await createUser(db);
  doc = await newDoc(db, userID, "Linear stage");
  for (const [path, content] of Object.entries(SCRIPTS)) await run(db, mutators.script.write({ documentID: doc, path, content, baseVersion: null }), { userID });
  // a note on the base's top face, with a reply
  const [names] = await pool.run({ document: "probe", scripts: SCRIPTS, ops: [{ op: "regenerate", part: "parts" }, { op: "query", part: "parts", expr: ">Z", kind: "face" }] }).then((r: any[]) => [r[1].value as number[]]);
  const [desc] = (await pool.run({ document: "probe", scripts: SCRIPTS, ops: [{ op: "describe", part: "parts", kind: "face", index: names[0] }] })) as any[];
  const noteID = crypto.randomUUID();
  const snapshot = "0".repeat(64);
  await db.sql`INSERT INTO blobs (hash, size, content_type) VALUES (${snapshot}, 8, 'image/png')`;
  await run(db, mutators.note.create({
    id: noteID, documentID: doc, text: "Make the base plate 8 mm thick so it stops flexing.",
    anchor: { targets: [{ kind: "face", part: "parts", name: desc.value.name, point: desc.value.center, normal: [0, 0, 1] }], camera: { position: [180.123456, -220.98765, 140.5555], target: [0, 0, 3.0001], up: [0, 0, 1], fov: 45, ortho: false }, version: "v1", configuration: "Default", snapshot },
  } as any), { userID });
  await run(db, mutators.note.reply({ id: crypto.randomUUID(), noteID, text: "Also keep the mount holes where they are." } as any), { userID });

  const session: Session = { id: await createAgentSession(db, userID, "Claude"), userID, clientID: "c", clientName: "Claude", defaultDocument: doc, activeConfig: new Map(), lastVersion: new Map(), calls: [], noteCursors: new Map(), startedAt: Date.now() };
  const server = new McpServer({ name: "test", version: "1" });
  registerTools(server, session, { db, pool: pool as any, store: new FsBlobStore(tmpdir()), noteEvents: createNoteEvents(db), config: { appOrigin: "http://localhost", secret: "test" } });
  registerApiReference(server, session);
  client = new Client({ name: "sizes", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
}, 120_000);

afterAll(async () => {
  await client?.close();
  await db?.drop();
  if (process.env.RESPONSE_SIZES) {
    console.log(Object.entries(sizes).map(([k, v]) => `${k.padEnd(34)} ${String(v).padStart(7)} chars  ~${Math.round(v / 4)} tok`).join("\n"));
    console.log(`RESPONSE_SIZES_JSON ${JSON.stringify(sizes)}`);
  }
});

test("common tool results stay small", async () => {
  await call("list_documents");
  await call("open_document", { document: doc });
  await call("list_scripts");
  const script = parseListing(await call("read_script", { path: "studios/parts.ts" }));
  await call("edit_script", { path: "studios/parts.ts", baseVersion: script.version, edits: [{ search: "// A small linear stage", replace: "// A compact linear stage" }] }, "edit_script (result)");
  await call("list_problems");
  await call("list_notes");
  const notes = await call("list_notes", { status: "all" }, "list_notes (all)");
  await call("get_note", { id: notes.notes[0].id });
  await call("describe_model", { entities: false }, "describe_model (summary)");
  await call("describe_model", {}, "describe_model (default)");
  await call("describe_model", { part: "parts" }, "describe_model part (entities)");
  await call("query", { part: "parts", expr: ">Z" }, "query >Z");
  await call("query", { part: "parts", expr: "%circle", kind: "edge" }, "query %circle edges");
  await call("measure", { a: { part: "parts" }, b: { part: "parts:rail" } }, "measure parts");
  await call("measure", { a: { part: "parts", name: ">Z" }, b: { part: "parts", name: "<Z" } }, "measure faces");
  await call("check");
  await call("get_params");
  await call("set_param", { part: "parts", name: "width", value: 50 });
  await call("set_pose", { assembly: "stage", joints: { travel: 20 } });
  const versions = await call("list_versions");
  await call("read_version", { id: versions.versions[0].id });
  await call("bom");
  await call("bom", { assembly: "stage" }, "bom (assembly)");
  await call("drawing", { part: "parts" });
  await call("export", { part: "parts", format: "step" });
  await call("api_reference", {}, "api_reference (index)");
  await call("api_reference", { topic: "cheatsheet" }, "api_reference cheatsheet");
  await call("api_reference", { topic: "std" }, "api_reference std");
  await call("api_reference", { symbol: "Solid.fillet" }, "api_reference Solid.fillet");
  await client.callTool({ name: "render", arguments: {} }).catch(() => {});
  const render = pool.renders.at(-1);
  expect([render.width, render.height]).toEqual([800, 600]);

  // characters, with headroom over what this example measures; the comments are the sizes before
  // the token-efficiency pass (pretty-printed JSON, full script contents, every neighbor, …)
  const budget: Record<string, number> = {
    list_scripts: 400, // 4305
    "edit_script (result)": 400, // 557
    list_problems: 300, // 389
    list_notes: 1_200, // 2959
    get_note: 1_500, // 2546
    "describe_model (summary)": 3_000, // 6052
    "describe_model part (entities)": 18_000, // 52875
    "query %circle edges": 8_000, // 20148
    check: 500, // 893
    get_params: 500, // 850
    set_param: 400, // 624
    set_pose: 400, // 899
    read_version: 300, // 3977
    bom: 1_200, // 1798
    "api_reference std": 4_000, // 16525
  };
  expect(Object.entries(budget).filter(([k, max]) => !(sizes[k]! <= max)).map(([k, max]) => `${k}: ${sizes[k]} > ${max}`)).toEqual([]);
  // JSON results are compact (no indentation)
  expect(pretty).toEqual([]);
}, 300_000);
