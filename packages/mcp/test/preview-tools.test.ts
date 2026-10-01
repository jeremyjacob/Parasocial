// set_param / set_pose previews stay in their MCP session; render/describe/check see them; "shared"
// writes the document. Needs the test Postgres (packages/sync/README.md). The engine pool is faked
// with the runtime engine in-process (renders are recorded, not drawn).
import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadKernel } from "@parasocial/kernel";
import { Engine } from "@parasocial/runtime";
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

/** The pool's job protocol over an in-process engine, one per pool document (like the real pool). */
class FakePool {
  renders: any[] = [];
  private slots = new Map<string, { e: Engine; scripts: string; overrides: Record<string, Record<string, string | number>> }>();
  async run(job: { document: string; scripts: Record<string, string>; overrides?: Record<string, Record<string, string | number>>; ops: any[] }) {
    let slot = this.slots.get(job.document);
    const scripts = JSON.stringify(job.scripts);
    if (!slot || slot.scripts !== scripts) {
      const e = new Engine();
      e.setDocument({ scripts: job.scripts, overrides: job.overrides ?? {} });
      this.slots.set(job.document, (slot = { e, scripts, overrides: job.overrides ?? {} }));
    } else {
      const o = job.overrides ?? {};
      for (const part of new Set([...Object.keys(o), ...Object.keys(slot.overrides)])) slot.e.setOverrides(part, o[part] ?? {});
      slot.overrides = o;
    }
    const e = slot.e;
    return job.ops.map((op) => {
      try {
        return { ok: true as const, value: this.op(e, op) };
      } catch (err) {
        return { ok: false as const, error: (err as Error).message };
      }
    });
  }
  private op(e: Engine, op: any): unknown {
    switch (op.op) {
      case "parts":
        return e.partInfos();
      case "regenerate": {
        const { mesh, ...meta } = e.regenerate(op.part);
        return meta;
      }
      case "assemblies":
        return e.assemblies();
      case "setPoses":
        return void e.setPoses(op.poses);
      case "interferences":
        if (op.poses) e.setPoses(op.poses);
        return e.interferences(op.parts, op.ignore).map(({ mesh, ...x }) => x);
      case "interference":
        return e.interference(op.a, op.b);
      case "measure":
        return e.measure(op.a, op.b);
      case "check":
        return e.check(op.part);
      case "describeAll":
        return e.describeAll(op.part);
      case "render":
        this.renders.push(op);
        return { png: "" };
      default:
        throw new Error(`fake pool: ${op.op}`);
    }
  }
}

test("previews are per session; shared scope writes the document", async () => {
  const db = await createTestDb();
  const pool = new FakePool();
  const opened: { client: Client; server: McpServer }[] = [];
  try {
    const userID = await createUser(db);
    const doc = await newDoc(db, userID, "Hinge");
    for (const [path, content] of Object.entries(SCRIPTS)) await run(db, mutators.script.write({ documentID: doc, path, content, baseVersion: null }), { userID });

    async function connect(name: string) {
      const session: Session = { id: await createAgentSession(db, userID, name), userID, clientID: name, clientName: name, defaultDocument: doc, activeConfig: new Map(), lastVersion: new Map(), calls: [], noteCursors: new Map(), startedAt: Date.now() };
      const server = new McpServer({ name: "test", version: "1" });
      const client = new Client({ name, version: "1" });
      registerTools(server, session, { db, pool: pool as any, store: new FsBlobStore(tmpdir()), noteEvents: createNoteEvents(db), config: { appOrigin: "http://localhost", secret: "test" } });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await server.connect(st);
      await client.connect(ct);
      opened.push({ client, server });
      const call = async (tool: string, args: Record<string, unknown> = {}) => {
        const r = await client.callTool({ name: tool, arguments: args });
        const t = (r.content as { type: string; text?: string }[])[0];
        if (r.isError) throw new Error(t?.text);
        return t?.type === "text" ? JSON.parse(t.text!) : r;
      };
      return { session, call };
    }
    const A = await connect("Claude");
    const B = await connect("Codex");
    const versions = async () => Number((await db.sql`SELECT count(*)::int AS n FROM versions WHERE document_id = ${doc}`)[0]!.n);
    const configurations = async () => Number((await db.sql`SELECT count(*)::int AS n FROM configurations WHERE document_id = ${doc}`)[0]!.n);
    const savedPoses = async () => ((await db.sql`SELECT settings FROM documents WHERE id = ${doc}`)[0]!.settings as any)?.poses;
    const v0 = await versions();
    const top = async (who: typeof A, part: string) => (await who.call("describe_model", { part, entities: false })).parts[0].bbox.max[2];

    // ---- params: session preview by default
    const set = await A.call("set_param", { part: "box", name: "height", value: 60 });
    expect(set.scope).toBe("session");
    expect(set.regeneration[0].bbox.max[2]).toBe(60);
    expect(await top(A, "box")).toBe(60);
    expect(await top(B, "box")).toBe(40);
    expect(await versions()).toBe(v0);
    expect(await configurations()).toBe(0);
    expect((await A.call("get_params")).parts.find((p: any) => p.part === "box").params.find((p: any) => p.name === "height")).toMatchObject({ override: "60", preview: true, effective: 60 });
    await expect(A.call("set_param", { part: "box", name: "heigth", value: 1 })).rejects.toThrow(/No param "heigth" on box\. Params: height, bay/);
    expect(A.session.preview?.get(doc)?.params).toEqual({ box: { height: 60 } });
    await A.call("reset_param", { part: "box", name: "height" });
    expect(await top(A, "box")).toBe(40);
    expect(await versions()).toBe(v0);

    // ---- poses: session preview by default
    const pose = await A.call("set_pose", { assembly: "mechanism", joints: { lid: 90 } });
    expect(pose.scope).toBe("session");
    expect(pose.joints.map((j: any) => [j.name, j.value[0], j.from])).toEqual([["lid", 90, "session"], ["drawer", 0, "home"]]);
    expect(await savedPoses()).toBeUndefined();
    expect(await top(A, "mechanism/box:lid")).toBeGreaterThan(80);
    expect(await top(B, "mechanism/box:lid")).toBe(43);
    await expect(A.call("set_pose", { assembly: "mechanism", joints: { hinge: 1 } })).rejects.toThrow(/No movable joint "hinge"/);
    await expect(A.call("set_pose", { assembly: "nope" })).rejects.toThrow(/Assemblies: mechanism \(Hinged box\)/);

    // describe_model without a part lists assemblies with where each value comes from
    const described = await A.call("describe_model", { entities: false });
    expect(described.sessionPreview.poses).toEqual({ mechanism: { lid: [90] } });
    expect(described.assemblies[0]).toMatchObject({ id: "mechanism", instances: ["mechanism/box", "mechanism/box:lid", "mechanism/box:drawer"] });

    // ---- render: assembly ids expand to instances, posed for this session only
    await A.call("render", { parts: ["mechanism"] }).catch(() => {});
    let r = pool.renders.at(-1);
    expect(r.parts).toEqual(["mechanism/box", "mechanism/box:lid", "mechanism/box:drawer"]);
    expect(Object.keys(r.poses)).toEqual(["mechanism/box:lid"]);
    expect(r.up).toBe("z");
    await B.call("render", { parts: ["mechanism/box:lid"], up: "y", camera: { position: [100, 100, 100], target: [0, 0, 0] } }).catch(() => {});
    r = pool.renders.at(-1);
    expect(r.parts).toEqual(["mechanism/box:lid"]);
    expect(r.poses).toEqual({});
    expect(r.up).toBe("y");
    expect(r.camera.up).toEqual([0, 1, 0]);
    await A.call("render").catch(() => {});
    expect(pool.renders.at(-1).parts).toEqual(["box", "box:lid", "box:drawer"]);
    await expect(A.call("render", { parts: ["mechanism/box:nope"] })).rejects.toThrow(/Unknown part, instance or assembly: mechanism\/box:nope/);

    // ---- check: per-assembly interference at the session pose
    const checked = await A.call("check");
    expect(checked.assemblies).toEqual([{ assembly: "mechanism", interference: [] }]);

    // ---- shared: saves the whole pose (including this session's lid) for everyone, no version
    const shared = await A.call("set_pose", { assembly: "mechanism", joints: { drawer: 20 }, scope: "shared" });
    expect(shared.joints.map((j: any) => [j.name, j.value[0], j.from])).toEqual([["lid", 90, "shared"], ["drawer", 20, "shared"]]);
    expect(await savedPoses()).toEqual({ mechanism: { lid: [90], drawer: [20] } });
    expect(A.session.preview?.get(doc)?.poses).toEqual({});
    expect(await top(B, "mechanism/box:lid")).toBeGreaterThan(80);
    expect(await versions()).toBe(v0);
    // B previews on top of the shared pose without disturbing it
    await B.call("set_pose", { assembly: "mechanism", joints: { lid: 0 } });
    expect(await top(B, "mechanism/box:lid")).toBe(43);
    expect(await top(A, "mechanism/box:lid")).toBeGreaterThan(80);
    await B.call("set_pose", { assembly: "mechanism", reset: true });
    expect(await top(B, "mechanism/box:lid")).toBeGreaterThan(80);

    // ---- shared params keep the old behavior: a configuration and a version
    const saved = await A.call("set_param", { part: "box", name: "height", value: 55, scope: "shared" });
    expect(saved.scope).toBe("shared");
    expect(await configurations()).toBe(1);
    expect(await versions()).toBe(v0 + 1);
  } finally {
    for (const o of opened) (await o.client.close(), await o.server.close());
    await db.drop();
  }
}, 60_000);
