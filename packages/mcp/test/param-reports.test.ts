// set_param replies stay compact (counts, problems, parts whose bbox moved) and describe_model lists
// params once (shared ones at the top, instances under their part) with an assemblies-only mode.
// Needs the test Postgres (packages/sync/README.md); the engine pool is faked in-process.
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
// body and lid share one document-wide "height"; the drawer doesn't declare it
const box = readFileSync(join(root, "studios/box.ts"), "utf8").replaceAll('param("height", 40, { min: 30, max: 80, unit: mm })', 'param("height", 40, { min: 30, max: 80, unit: mm, shared: true })');
const SCRIPTS = { "studios/box.ts": box, "studios/mechanism.ts": readFileSync(join(root, "studios/mechanism.ts"), "utf8") };

beforeAll(async () => {
  await loadKernel();
});

test("set_param reports compactly; describe_model lists params once", async () => {
  expect(box.match(/shared: true/g)?.length).toBe(2);
  const db = await createTestDb();
  const pool = new FakePool();
  const userID = await createUser(db);
  const doc = await newDoc(db, userID, "Hinge");
  for (const [path, content] of Object.entries(SCRIPTS)) await run(db, mutators.script.write({ documentID: doc, path, content, baseVersion: null }), { userID });
  const session: Session = { id: await createAgentSession(db, userID, "Claude"), userID, clientID: "c", clientName: "Claude", defaultDocument: doc, activeConfig: new Map(), lastVersion: new Map(), calls: [], noteCursors: new Map(), startedAt: Date.now() };
  const server = new McpServer({ name: "test", version: "1" });
  const client = new Client({ name: "c", version: "1" });
  registerTools(server, session, { db, pool: pool as any, store: new FsBlobStore(tmpdir()), noteEvents: createNoteEvents(db), config: { appOrigin: "http://localhost", secret: "test" } });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name: tool, arguments: args });
    const t = (r.content as { type: string; text?: string }[])[0];
    if (r.isError) throw new Error(t?.text);
    return JSON.parse(t!.text!);
  };
  try {
    // ---- shared param, session scope: every part regenerates, only the ones declaring it are reported
    const set = await call("set_param", { part: "*", name: "height", value: 60 });
    expect(set.parts).toEqual({ regenerated: 3, ok: 3 });
    expect(Object.keys(set.bboxChanged).sort()).toEqual(["box", "box:lid"]);
    expect(set.bboxChanged.box).toEqual({ bbox: { min: [-35, -25, 0], max: [35, 25, 60] }, was: { min: [-35, -25, 0], max: [35, 25, 40] } });
    expect(set.regeneration).toBeUndefined();
    expect(set.problems).toBeUndefined();
    expect(set.sessionPreview).toEqual({ "*": { height: 60 } });
    // same value again: nothing moved
    expect((await call("set_param", { part: "*", name: "height", value: 60 })).bboxChanged).toBeUndefined();
    // verbose: every part's summary
    const loud = await call("set_param", { part: "*", name: "height", value: 65, verbose: true });
    expect(loud.regeneration.map((r: any) => r.part)).toEqual(["box", "box:lid", "box:drawer"]);
    expect(loud.bboxChanged.box.was.max[2]).toBe(60);
    // out of bounds: the problem is listed per part
    const bad = await call("set_param", { part: "*", name: "height", value: 200 });
    expect(bad.parts.ok).toBeLessThan(3);
    expect(Object.keys(bad.problems)).toContain("box");

    // ---- reset: same compact form
    const reset = await call("set_param", { part: "*", name: "height", value: null });
    expect(reset.scope).toBe("session");
    expect(reset.parts.regenerated).toBe(3);
    expect(session.preview?.get(doc)?.params).toEqual({});
    // ---- single part, instance id maps to its part
    const one = await call("set_param", { part: "mechanism/box:lid", name: "thickness", value: 4 });
    expect(one.parts).toEqual({ regenerated: 1, ok: 1 });
    expect(one.bboxChanged["box:lid"].bbox.max[2]).toBe(44);
    await call("set_param", { part: "box:lid", name: "thickness", value: null });

    // ---- shared scope with "*": a version, all parts regenerated, moved bboxes vs. before
    const saved = await call("set_param", { part: "*", name: "height", value: 50, scope: "shared" });
    expect(saved.scope).toBe("shared");
    expect(saved.parts.regenerated).toBe(3);
    expect(saved.bboxChanged["box:lid"].was.max[2]).toBe(43);
    expect(saved.bboxChanged["box:lid"].bbox.max[2]).toBe(53);
    const cleared = await call("set_param", { part: "*", name: "height", value: null, scope: "shared" });
    expect(cleared.bboxChanged.box.bbox.max[2]).toBe(40);

    // ---- describe_model: shared params once, others once per source part, none on part entries
    await call("set_param", { part: "*", name: "height", value: 45 });
    const all = await call("describe_model", { entities: false });
    expect(all.sharedParams).toEqual({ height: "45 mm (override) (preview)" });
    expect(Object.keys(all.params).sort()).toEqual(["box", "box:drawer", "box:lid"]);
    expect(all.params.box.height).toBeUndefined();
    expect(all.parts.every((p: any) => p.params === undefined)).toBe(true);
    const asm = await call("describe_model", { part: "mechanism", entities: false });
    expect(asm.parts.map((p: any) => p.part)).toEqual(["mechanism/box", "mechanism/box:lid", "mechanism/box:drawer"]);
    expect(Object.keys(asm.params).sort()).toEqual(["box", "box:drawer", "box:lid"]);
    const bare = await call("describe_model", { entities: false, params: false });
    expect(bare.params).toBeUndefined();
    expect(bare.sharedParams).toBeUndefined();

    // ---- assemblies only
    await call("set_pose", { assembly: "mechanism", joints: { lid: 90 } });
    const only = await call("describe_model", { assemblies: true });
    expect(only.parts).toBeUndefined();
    expect(only.assemblies).toEqual([{ id: "mechanism", name: "Hinged box", instances: 3, joints: { lid: "revolute 90 deg (0..110) session", drawer: "slider 0 mm (0..40) home" } }]);
    expect(only.sessionPoses).toEqual({ mechanism: { lid: [90] } });
    expect((await call("describe_model", { assemblies: true, part: "Hinged box" })).assemblies).toHaveLength(1);
    await expect(call("describe_model", { assemblies: true, part: "box" })).rejects.toThrow(/No assembly "box"/);
  } finally {
    await client.close();
    await server.close();
    await db.drop();
  }
}, 60_000);
