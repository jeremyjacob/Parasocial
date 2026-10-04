// check: interference with the overlap's box and centroid, clearance (non-interfering pairs closer
// than it), intended overlaps, near, and partial runs; per assembly at the session pose, studio
// parts no assembly uses at their modeled place. Needs the test Postgres (packages/sync/README.md);
// the engine pool is faked.
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

async function setup(name: string, scripts: Record<string, string>, pool: { run(job: any): Promise<any> } = new FakePool()) {
  const db = await createTestDb();
  const userID = await createUser(db);
  const doc = await newDoc(db, userID, name);
  for (const [path, content] of Object.entries(scripts)) await run(db, mutators.script.write({ documentID: doc, path, content, baseVersion: null }), { userID });
  const session: Session = { id: await createAgentSession(db, userID, "Claude"), userID, clientID: "c", clientName: "Claude", defaultDocument: doc, activeConfig: new Map(), lastVersion: new Map(), calls: [], noteCursors: new Map(), startedAt: Date.now() };
  const server = new McpServer({ name: "test", version: "1" });
  const client = new Client({ name: "c", version: "1" });
  registerTools(server, session, { db, pool: pool as any, store: new FsBlobStore(tmpdir()), noteEvents: createNoteEvents(db), config: { appOrigin: "http://localhost", secret: "test" } });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name: tool, arguments: args });
    const t = (r.content as { type: string; text?: string }[])[0];
    if (r.isError) throw new Error(t?.text);
    return JSON.parse(t.text!);
  };
  return { call, close: async () => (await client.close(), await server.close(), await db.drop()) };
}

test("check clearance lists near pairs, closest first, with the part filter", async () => {
  const { call, close } = await setup("Hinge", SCRIPTS);
  try {
    const plain = await call("check");
    expect(plain.near).toBeUndefined();
    expect(plain.assemblies[0].near).toBeUndefined();
    // closed box: lid and drawer touch the body (distance 0), not each other. The mechanism uses
    // every part of the box studio, so they're checked there, not again where they're modeled
    const near = await call("check", { clearance: 5 });
    expect(near.interference).toEqual([]);
    expect(near.near).toEqual([]);
    expect(near.assemblies[0].near.map((x: any) => [x.a, x.b, x.distance])).toEqual([["mechanism/box", "mechanism/box:lid", 0], ["mechanism/box", "mechanism/box:drawer", 0]]);
    expect(near.assemblies[0].near[0].points).toEqual([[-35, -25, 40], [-35, -25, 40]]);
    const lid = await call("check", { part: "box:lid", clearance: 5 });
    expect(lid.valid).toBe(1);
    expect(lid.assemblies[0].near.map((x: any) => x.b)).toEqual(["mechanism/box:lid"]);
    // drawer slid out at the session pose: it rides 0.4 mm off the body
    await call("set_pose", { assembly: "mechanism", joints: { drawer: 20 } });
    const open = await call("check", { part: "mechanism/box:drawer", clearance: 1 });
    expect(open.assemblies[0].near).toEqual([{ a: "mechanism/box", b: "mechanism/box:drawer", distance: 0.4, points: [[31.1, 1.1, 13], [31.1, 1.1, 12.6]] }]);
    expect((await call("check", { part: "mechanism/box:drawer", clearance: 0.3 })).assemblies[0].near).toEqual([]);
  } finally {
    await close();
  }
});

// a plate with a pin pressed in and a second pin 5 mm over (an unintended overlap), a nut away from
// both; a studio no assembly uses, with two overlapping blocks
const PARTS = `import { part, box, cylinder } from "parasocial";
export default part("Plate", () => box(20, 20, 4, { center: "xy" }));
export const pin = part("Pin", () => cylinder(2, 10, { center: true }));
export const nut = part("Nut", () => box(4, 4, 4).translate([30, 0, 0]));
`;
const RIG = `import { assembly } from "parasocial";
import plate, { pin, nut } from "./parts";
export default assembly("Rig", ({ fastened, insert, expectOverlap }) => {
  fastened(plate, pin);
  fastened(plate, nut);
  insert(pin, { name: "2", place: { translate: [5, 0, 0] } });
  expectOverlap(plate, pin, { reason: "press fit" });
});
`;
const LOOSE = `import { part, box } from "parasocial";
export default part("A", () => box(10, 10, 10));
export const b = part("B", () => box(10, 10, 10).translate([5, 0, 0]));
`;
const RIG_SCRIPTS = { "studios/parts.ts": PARTS, "studios/rig.ts": RIG, "studios/loose.ts": LOOSE };

test("check: overlap boxes and centroids, expected overlaps, near, partial runs; measure says where parts overlap", async () => {
  // the first overlapPairs request fails, as when it crashes the engine
  const fake = new FakePool();
  let fail = false;
  const pool = { run: async (job: any) => (await fake.run(job)).map((r: any, i: number) => (fail && job.ops[i].op === "overlapPairs" ? ((fail = false), { ok: false, error: "the engine crashed" }) : r)) };
  const { call, close } = await setup("Rig", RIG_SCRIPTS, pool);
  try {
    const all = await call("check");
    // loose.ts: its two blocks share 5 × 10 × 10; parts.ts and loose.ts parts are never shown together
    expect(all.interference).toEqual([{ a: "loose", b: "loose:b", volume: 500, bbox: { min: [5, 0, 0], max: [10, 10, 10] }, centroid: [7.5, 5, 5] }]);
    const [rig] = all.assemblies;
    // the pressed-in pin is expected; the second one isn't
    expect(rig.expected).toBe(1);
    expect(rig.interference).toEqual([{ a: "rig/parts", b: "rig/parts:pin@2", volume: 50.265, bbox: { min: [3, -2, 0], max: [7, 2, 4] }, centroid: [5, 0, 2] }]);
    expect(all.skipped).toBeUndefined();
    // near: only pairs with that copy; with part, only between the two
    const only = await call("check", { near: "rig/parts:pin@2" });
    expect(only.interference).toEqual([]);
    expect(only.assemblies[0].interference.map((x: any) => [x.a, x.b])).toEqual([["rig/parts", "rig/parts:pin@2"]]);
    expect(only.assemblies[0].expected).toBeUndefined();
    const between = await call("check", { part: "rig/parts:pin@2", near: "rig/parts:pin", clearance: 2 });
    expect(between.valid).toBe(1);
    expect(between.assemblies[0]).toEqual({ assembly: "rig", interference: [], near: [{ a: "rig/parts:pin", b: "rig/parts:pin@2", distance: 1, points: expect.any(Array) }] });
    expect(between.assemblies[0].near[0].points.map((p: number[]) => p[0])).toEqual([2, 3]);
    // a source part stands for its copies
    const pins = await call("check", { near: "parts:pin" });
    expect([pins.assemblies[0].expected, pins.assemblies[0].interference.length]).toEqual([1, 1]);
    await expect(call("check", { near: "nope" })).rejects.toThrow("Unknown part, instance, assembly or subassembly: nope");
    // a failed request: its pairs are skipped and said, the rest still run
    fail = true;
    const partial = await call("check", { clearance: 1 });
    expect(partial.skipped).toEqual({ pairs: 6, reason: "the engine crashed", hint: "check fewer pairs with near or part" });
    expect([partial.interference, partial.assemblies[0].interference, partial.assemblies[0].near]).toEqual([[], [], []]);
    // out of time: nothing more is sent
    process.env.CHECK_BUDGET_MS = "-1";
    try {
      expect((await call("check")).skipped).toEqual({ pairs: 6, reason: "out of time (0 s)", hint: "check fewer pairs with near or part" });
    } finally {
      delete process.env.CHECK_BUDGET_MS;
    }
    // measure: overlapping parts get the overlap's box and centroid, and a word on the points
    const m = await call("measure", { a: { part: "rig/parts" }, b: { part: "rig/parts:pin@2" } });
    expect(m.distance).toBe(0);
    expect(m.interferenceVolume).toBe(50.265);
    expect(m.overlap).toEqual({ bbox: { min: [3, -2, 0], max: [7, 2, 4] }, centroid: [5, 0, 2] });
    expect(m.note).toContain("contact point");
    const apart = await call("measure", { a: { part: "rig/parts:pin" }, b: { part: "rig/parts:pin@2" } });
    expect([apart.distance, apart.interferenceVolume, apart.overlap, apart.note]).toEqual([1, 0, undefined, undefined]);
  } finally {
    await close();
  }
});
