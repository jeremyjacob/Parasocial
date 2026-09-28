import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutators } from "../src/mutators.ts";
import { zql } from "../src/schema.ts";
import { sha256Hex } from "../src/util.ts";
import {
  buildDocumentZip,
  createZipHandlers,
  exportDocument,
  importDocument,
  parseDocumentZip,
  readDocumentDir,
} from "../src/server/zip.ts";
import { createTestDb, createUser, newDoc, run, type TestDb } from "./helpers.ts";

let db: TestDb;
let ada: string;
beforeAll(async () => {
  db = await createTestDb();
  ada = await createUser(db, "Ada");
});
afterAll(() => db.drop());

const BRACKET = `import { part, param, sketch, plane, mm } from "parasocial";\nexport default part("Bracket", () => sketch(plane.XY).rect(param("width", 40), 25).extrude(param("thickness", 3)));\n`;

async function seedDoc() {
  const doc = await newDoc(db, ada, "Bracket");
  await run(db, mutators.document.updateSettings({ id: doc, units: "in", settings: { grid: 5 } }), { userID: ada });
  await run(db, mutators.script.write({ documentID: doc, path: "studios/bracket.ts", content: BRACKET, baseVersion: null }), { userID: ada });
  await run(db, mutators.script.write({ documentID: doc, path: "lib/holes/counterbore.ts", content: "export const cb = 1;\n", baseVersion: null }), { userID: ada });
  const cfg = crypto.randomUUID();
  await run(db, mutators.configuration.create({ id: cfg, documentID: doc, name: "M3", overrides: [{ part: "studios/bracket.ts", name: "thickness", expression: "=width/10", value: 4 }] }), { userID: ada });
  const hash = await sha256Hex("snap");
  await db.sql`INSERT INTO blobs (hash, size, content_type) VALUES (${hash}, 4, 'image/png') ON CONFLICT DO NOTHING`;
  const noteID = crypto.randomUUID();
  await run(db, mutators.note.create({
    id: noteID,
    documentID: doc,
    text: "wall too thin",
    anchor: {
      targets: [
        { kind: "face", name: "bracket/extrude1 · side · sketch1/line3", point: [1, 2, 3], normal: [0, 1, 0] },
        { kind: "studio", studio: "studios/bracket.ts", name: "Bracket", point: [0, 0, 0] },
      ],
      camera: { position: [100, 100, 100], target: [0, 0, 0], up: [0, 0, 1], fov: 40, ortho: true },
      version: "v3",
      configuration: "M3",
      snapshot: hash,
    },
    strokes: [{ id: crypto.randomUUID(), part: "studios/bracket.ts", points: [[0, 0, 0], [1, 1, 1]], color: "#e5484d" }],
  }), { userID: ada });
  await run(db, mutators.note.reply({ id: crypto.randomUUID(), noteID, text: "agreed" }), { userID: ada });
  const removed = crypto.randomUUID();
  await run(db, mutators.note.create({ id: removed, documentID: doc, anchor: { targets: [{ kind: "part", name: "bracket", point: [0, 0, 0] }], camera: { position: [1, 1, 1], target: [0, 0, 0], up: [0, 0, 1], fov: 40, ortho: false }, version: "v1", configuration: "Default", snapshot: hash } }), { userID: ada });
  await run(db, mutators.note.remove({ noteID: removed }), { userID: ada });
  return doc;
}

describe("zip round-trip", () => {
  test("export → zip → parse → import → export is stable", async () => {
    const doc = await seedDoc();
    const exported = await exportDocument(db, doc, ada);
    expect(exported.manifest).toEqual({
      format: "parasocial/1",
      name: "Bracket",
      units: "in",
      settings: { grid: 5 },
      configurations: [{ name: "M3", overrides: [{ part: "studios/bracket.ts", name: "thickness", expression: "=width/10", value: 4 }] }],
    });
    expect(exported.scripts.map((s) => s.path)).toEqual(["lib/holes/counterbore.ts", "studios/bracket.ts"]);
    expect(exported.notes).toHaveLength(1); // removed notes are not exported
    expect(exported.notes![0]!.messages.map((m) => [m.author, m.text])).toEqual([["Ada", "wall too thin"], ["Ada", "agreed"]]);

    const zip = buildDocumentZip(exported);
    // deterministic
    expect(buildDocumentZip(exported)).toEqual(zip);
    const parsed = parseDocumentZip(zip);
    expect(parsed.scripts).toEqual(exported.scripts);
    expect(parsed.manifest).toEqual(exported.manifest);

    const { documentID } = await importDocument(db, parsed, { userID: ada });
    const again = await exportDocument(db, documentID, ada);
    expect(again.manifest).toEqual(exported.manifest);
    expect(again.scripts).toEqual(exported.scripts);
    // Notes round-trip exactly except message timestamps (import time) — authors are preserved.
    const strip = (ns: typeof exported.notes) => ns!.map((n) => ({ ...n, messages: n.messages.map(({ createdAt: _c, ...m }) => m) }));
    expect(strip(again.notes)).toEqual(strip(exported.notes));
    // and a second round-trip is a fixed point
    const third = await importDocument(db, parseDocumentZip(buildDocumentZip(again)), { userID: ada });
    expect(strip((await exportDocument(db, third.documentID, ada)).notes)).toEqual(strip(exported.notes));

    // import created exactly one version and the importer owns it
    const versions = await db.zql.run(zql.versions.where("documentID", documentID));
    expect(versions.map((v) => [v.number, v.kind, v.message])).toEqual([[1, "import", "Imported"]]);
    const members = await db.zql.run(zql.documentMembers.where("documentID", documentID));
    expect(members).toMatchObject([{ userID: ada, role: "owner" }]);
  });

  test("rejects paths outside studios/ and lib/, zip-slip and junk", () => {
    const mk = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
    const manifest = JSON.stringify({ name: "x", units: "mm", configurations: [] });
    expect(() => parseDocumentZip(mk({ "parasocial.json": manifest, "evil.sh": "rm -rf" }))).toThrow(/outside studios/);
    expect(() => parseDocumentZip(mk({ "parasocial.json": manifest, "studios/../../etc.ts": "x" }))).toThrow();
    expect(() => parseDocumentZip(mk({ "parasocial.json": manifest, "studios/a/b.ts": "x" }))).toThrow(/flat/);
    expect(() => parseDocumentZip(mk({ "studios/a.ts": "x" }))).toThrow(/parasocial.json is missing/);
    expect(() => parseDocumentZip(new Uint8Array([1, 2, 3]))).toThrow(/valid zip/);
    // a single wrapping folder is fine (zipping a directory)
    const wrapped = parseDocumentZip(mk({ "bracket/parasocial.json": manifest, "bracket/studios/a.ts": "x", "__MACOSX/._a": "" }));
    expect(wrapped.scripts.map((s) => s.path)).toEqual(["studios/a.ts"]);
    // exports from before studios/ (parts/) still import
    const legacy = parseDocumentZip(mk({ "parasocial.json": manifest, "parts/a.ts": "x", "lib/b.ts": "y" }));
    expect(legacy.scripts.map((s) => s.path)).toEqual(["lib/b.ts", "studios/a.ts"]);
  });

  test("reads the same layout from a directory (examples/ seeding)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ps-example-"));
    await mkdir(join(dir, "studios"));
    await mkdir(join(dir, "lib"));
    await writeFile(join(dir, "parasocial.json"), JSON.stringify({ name: "Lid", units: "mm", configurations: [] }));
    await writeFile(join(dir, "studios", "lid.ts"), "export default 1;\n");
    await writeFile(join(dir, ".DS_Store"), "junk");
    const p = await readDocumentDir(dir);
    expect(p.scripts).toEqual([{ path: "studios/lid.ts", content: "export default 1;\n" }]);
    const { documentID } = await importDocument(db, p, { userID: ada });
    expect((await db.zql.run(zql.documents.where("id", documentID).one()))?.name).toBe("Lid");
    await rm(dir, { recursive: true, force: true });
  });

  test("HTTP handlers: export needs membership; import returns the new document", async () => {
    const doc = await seedDoc();
    const bob = await createUser(db, "Bob");
    const origin = "https://cad.example.test";
    const h = createZipHandlers({ db, config: { appOrigin: origin, engineOrigins: [] }, resolveUser: async (r) => ({ userID: r.headers.get("x-user")! }) });
    expect((await h.handle(new Request(`${origin}/api/documents/${doc}/export`, { headers: { "x-user": bob } }))).status).toBe(403);
    const res = await h.handle(new Request(`${origin}/api/documents/${doc}/export`, { headers: { "x-user": ada } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="Bracket.zip"');
    const zip = new Uint8Array(await res.arrayBuffer());
    const imp = await h.handle(new Request(`${origin}/api/documents/import?name=Copy`, { method: "POST", headers: { "x-user": bob, origin }, body: zip }));
    expect(imp.status).toBe(200);
    const { documentID } = (await imp.json()) as { documentID: string };
    expect((await db.zql.run(zql.documents.where("id", documentID).one()))).toMatchObject({ name: "Copy", ownerID: bob });
  });
});
