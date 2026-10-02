// Benchmark the real MCP handlers + Deno/WebGPU pool against a locally exported project.
// Production data stays outside git; every mutation runs in a disposable test database.
// bun packages/mcp/bench/performance.ts <project.json> <pool-url> <results.json> [samples]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PoolClient } from "@parasocial/engine-pool/client";
import { FsBlobStore } from "@parasocial/sync/server";
import { mutators, sha256Hex } from "@parasocial/sync";
import { createTestDb, createUser, createAgentSession, newDoc, run } from "../../sync/test/helpers";
import { createNoteEvents } from "../src/note-events";
import { registerTools, type Session } from "../src/tools";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [file, url, output, count = "3"] = process.argv.slice(2);
if (!file || !url || !output) throw new Error("Expected project.json, pool-url, results.json, [samples]");
const samples = Number(count);
if (!Number.isInteger(samples) || samples < 1) throw new Error("samples must be a positive integer");
const project = await Bun.file(file).json();
const deadline = Date.now() + 60_000;
while (!(await fetch(`${url}/health`).then((r) => r.ok).catch(() => false))) {
  if (Date.now() > deadline) throw new Error("Engine pool did not start within 60 seconds");
  await Bun.sleep(250);
}
const db = await createTestDb();
const server = new McpServer({ name: "performance", version: "1" });
const client = new Client({ name: "performance", version: "1" });
const dir = mkdtempSync(join(tmpdir(), "parasocial-bench-"));
const artifacts = output.replace(/\.json$/, "") + "-responses";
mkdirSync(artifacts, { recursive: true });
const measurements: Record<string, { ms: number[]; medianMs?: number; bytes: number; poolJobs?: number; error?: string }> = {};
let partCount = 0;
let poolJobs = 0;
const pool = new PoolClient(url, "");
const realRun = pool.run.bind(pool);
pool.run = (job) => (poolJobs++, realRun(job));
async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 900_000 });
  if (result.isError) throw new Error((result.content as any[])[0]?.text);
  return result;
}
async function measure(label: string, fn: () => Promise<unknown>, n = samples) {
  const times: number[] = [];
  const startJobs = poolJobs;
  const m = measurements[label] = { ms: times, bytes: 0 };
  try {
    for (let i = 0; i < n; i++) {
      const t = performance.now();
      const result = await fn();
      times.push(performance.now() - t);
      m.bytes = Buffer.byteLength(JSON.stringify(result));
      if (i === 0) {
        await Bun.write(join(artifacts, `${label}.json`), JSON.stringify(result));
        for (const content of (result as any)?.content ?? []) if (content.type === "image") await Bun.write(join(artifacts, `${label}.png`), Buffer.from(content.data, "base64"));
      }
    }
    m.medianMs = [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)];
    console.log(`${label}: ${m.medianMs.toFixed(1)} ms (${poolJobs - startJobs} pool jobs)`);
  } catch (e) {
    m.error = String(e);
    console.log(`${label}: ${m.error}`);
  }
  m.poolJobs = poolJobs - startJobs;
  await Bun.write(output, JSON.stringify({ project: { name: project.name, parts: partCount, scripts: Object.keys(project.scripts).length, scriptBytes: Object.values(project.scripts as Record<string, string>).reduce((s, c) => s + Buffer.byteLength(c), 0) }, samples, measurements }, null, 2));
}
try {
  const userID = await createUser(db);
  const documentID = await newDoc(db, userID, project.name);
  await run(db, mutators.script.writeMany({ documentID, files: Object.entries(project.scripts as Record<string, string>).map(([path, content]) => ({ path, content, baseVersion: null })) }), { userID });
  if (project.settings) await db.sql`UPDATE documents SET settings = ${db.sql.json(project.settings)} WHERE id = ${documentID}`;
  const session: Session = { id: await createAgentSession(db, userID), userID, clientID: "performance", clientName: "performance", defaultDocument: documentID, activeConfig: new Map(), lastVersion: new Map(), calls: [], noteCursors: new Map(), startedAt: Date.now() };
  registerTools(server, session, { db, pool, store: new FsBlobStore(dir), noteEvents: createNoteEvents(db), config: { appOrigin: "http://localhost", secret: "benchmark" } });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  await measure("describe_model.cold", () => call("describe_model", { entities: false }), 1);
  const [{ value: infos }] = await realRun({ document: `${documentID}:default`, scripts: project.scripts, units: project.units, ops: [{ op: "parts" }] }) as { value: any[] }[];
  const part = infos[0].id;
  partCount = infos.length;
  console.log(`Parts: ${infos.length}, selected: ${part}`);
  for (const [name, args] of [
    ["list_scripts", {}], ["read_script", { path: infos[0].file }], ["list_notes", {}],
    ["get_params", {}], ["describe_model", { entities: false }],
    ["describe_model.part", { part }], ["query", { part, expr: ">Z", limit: 20 }],
    ["measure", { a: { part }, b: { part } }], ["list_problems", {}],
    ["render.full", { view: "iso" }], ["render.part", { parts: [part], view: "top" }],
    ["render.changed_view", { view: "front" }],
    ["bom", {}], ["drawing", { part, views: ["front"], format: "svg" }],
    ["export", { part, format: "stl" }],
  ] as [string, Record<string, unknown>][]) {
    await measure(name, () => call(name.split(".")[0], args));
  }
  const script = project.scripts[infos[0].file];
  let version = 1;
  await measure("write_script", async () => {
    const r = await call("write_script", { path: infos[0].file, content: script + `\n// benchmark revision ${version}\n`, baseVersion: version });
    version++;
    return r;
  });
  let batch = 0;
  await measure("write_scripts", async () => {
    const rows = await db.sql`SELECT path, version FROM scripts WHERE document_id = ${documentID}`;
    const versions = new Map(rows.map((r: any) => [r.path, Number(r.version)]));
    return call("write_scripts", { files: Object.entries(project.scripts as Record<string, string>).map(([path, content]) => ({ path, content: content + `\n// benchmark batch ${batch++}\n`, baseVersion: versions.get(path) })) });
  });
  // Check all pairs once; this includes the expensive assembly collision path.
  await measure("check", () => call("check"), 1);
  await measure("check.warm", () => call("check"));
  // Synthetic studio threads exercise note loading without sharing production notes.
  const snapshot = await sha256Hex("performance snapshot");
  await db.sql`INSERT INTO blobs (hash, size, content_type) VALUES (${snapshot}, 20, 'image/png')`;
  const anchor = {
    targets: [{ kind: "studio" as const, studio: infos[0].file, name: "Benchmark", point: [0, 0, 0] as [number, number, number] }],
    camera: { position: [10, 10, 10] as [number, number, number], target: [0, 0, 0] as [number, number, number], up: [0, 0, 1] as [number, number, number], fov: 45, ortho: false },
    version: "v1", configuration: "Default", snapshot,
  };
  for (let i = 0; i < 100; i++) await run(db, mutators.note.create({ id: crypto.randomUUID(), documentID, text: `Benchmark thread ${i}`, anchor }), { userID });
  await measure("list_notes.100", () => call("list_notes"));
} finally {
  await client.close();
  await server.close();
  await db.drop();
  rmSync(dir, { recursive: true, force: true });
}
if (Object.values(measurements).some((m) => m.error)) process.exitCode = 1;
