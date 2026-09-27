import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutators } from "../src/mutators.ts";
import {
  createBlobHandlers,
  FsBlobStore,
  S3BlobStore,
  signBlobURL,
  sweepBlobs,
  verifyBlobSignature,
  type BlobStore,
} from "../src/server/blobs.ts";
import { runMutator } from "../src/server/zero.ts";
import { createTestDb, createUser, newDoc, type TestDb } from "./helpers.ts";

const ORIGIN = "https://cad.example.test";
const config = { secret: "x".repeat(40), appOrigin: ORIGIN, engineOrigins: ["https://engine.cad.example.test"] };

let db: TestDb;
let dir: string;
let store: FsBlobStore;
let ada: string;
let bob: string;
let blobs: ReturnType<typeof createBlobHandlers>;

beforeAll(async () => {
  db = await createTestDb();
  dir = await mkdtemp(join(tmpdir(), "ps-blobs-"));
  store = new FsBlobStore(dir);
  ada = await createUser(db, "Ada");
  bob = await createUser(db, "Bob");
  // Tests authenticate with an "x-user" header instead of a session cookie.
  blobs = createBlobHandlers({ db, store, config, resolveUser: async (req) => (req.headers.get("x-user") ? { userID: req.headers.get("x-user")! } : null) });
});
afterAll(async () => {
  await db.drop();
  await rm(dir, { recursive: true, force: true });
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const upload = (user: string, documentID: string, body: Uint8Array<ArrayBuffer> = PNG, type = "image/png") =>
  blobs.handle(new Request(`${ORIGIN}/api/blobs?document=${documentID}`, { method: "POST", headers: { "x-user": user, "content-type": type, origin: ORIGIN }, body }));
const signReq = (user: string, documentID: string, hashes: string[]) =>
  blobs.handle(new Request(`${ORIGIN}/api/blobs/sign`, { method: "POST", headers: { "x-user": user, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ documentID, hashes }) }));

const anchor = (snapshot: string) => ({
  targets: [{ kind: "part" as const, name: "bracket", point: [0, 0, 0] as [number, number, number] }],
  camera: { position: [1, 1, 1] as [number, number, number], target: [0, 0, 0] as [number, number, number], up: [0, 0, 1] as [number, number, number], fov: 45, ortho: false },
  version: "v1",
  configuration: "Default",
  snapshot,
});

describe("signing", () => {
  test("HMAC signatures verify, expire and bind hash + document", () => {
    const hash = "a".repeat(64);
    const url = new URL(signBlobURL(config, { hash, documentID: "d1", ttlSeconds: 60 }));
    const exp = Number(url.searchParams.get("exp"));
    const sig = url.searchParams.get("sig")!;
    expect(verifyBlobSignature(config.secret, { hash, documentID: "d1", exp, sig })).toBe("ok");
    expect(verifyBlobSignature(config.secret, { hash, documentID: "d2", exp, sig })).toBe("bad");
    expect(verifyBlobSignature(config.secret, { hash: "b".repeat(64), documentID: "d1", exp, sig })).toBe("bad");
    expect(verifyBlobSignature(config.secret, { hash, documentID: "d1", exp: exp + 1, sig })).toBe("bad");
    expect(verifyBlobSignature("y".repeat(40), { hash, documentID: "d1", exp, sig })).toBe("bad");
    expect(verifyBlobSignature(config.secret, { hash, documentID: "d1", exp, sig, now: (exp + 1) * 1000 })).toBe("expired");
  });
});

describe("upload first, then reference", () => {
  test("members upload; non-members and bad types are rejected", async () => {
    const doc = await newDoc(db, ada);
    expect((await upload(bob, doc)).status).toBe(403);
    expect((await upload(ada, doc, PNG, "text/html")).status).toBe(415);
    const r = await upload(ada, doc);
    expect(r.status).toBe(200);
    const { hash, size } = (await r.json()) as { hash: string; size: number };
    expect(size).toBe(PNG.length);
    expect(await store.has(hash)).toBe(true);
    // idempotent
    expect((await upload(ada, doc)).status).toBe(200);
  });

  test("the full flow: upload → note.create → signed URL → fetch", async () => {
    const doc = await newDoc(db, ada);
    const bytes = new Uint8Array([...PNG, 9, 9]);
    const { hash } = (await (await upload(ada, doc, bytes)).json()) as { hash: string };
    const r = await runMutator(db, mutators.note.create({ id: crypto.randomUUID(), documentID: doc, anchor: anchor(hash), text: "look" }), { userID: ada });
    expect(r.ok).toBe(true);

    // non-member can't get a URL
    expect((await signReq(bob, doc, [hash])).status).toBe(403);
    const { urls } = (await (await signReq(ada, doc, [hash, "f".repeat(64)])).json()) as { urls: Record<string, string> };
    expect(Object.keys(urls)).toEqual([hash]); // unknown hash isn't signed
    const res = await blobs.handle(new Request(urls[hash]!));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);

    // tampering with the document or signature fails
    const tampered = new URL(urls[hash]!);
    tampered.searchParams.set("doc", "other");
    expect((await blobs.handle(new Request(tampered))).status).toBe(403);
  });

  test("a document can't sign blobs referenced only by other documents", async () => {
    const docA = await newDoc(db, ada);
    const docB = await newDoc(db, bob);
    const bytes = new Uint8Array([...PNG, 7]);
    const { hash } = (await (await upload(ada, docA, bytes)).json()) as { hash: string };
    await runMutator(db, mutators.note.create({ id: crypto.randomUUID(), documentID: docA, anchor: anchor(hash) }), { userID: ada });
    const { urls } = (await (await signReq(bob, docB, [hash])).json()) as { urls: Record<string, string> };
    expect(urls).toEqual({});
  });

  test("engine origin is rejected", async () => {
    const res = await blobs.handle(new Request(`${ORIGIN}/api/blobs/sign`, { method: "POST", headers: { origin: config.engineOrigins[0]!, "x-user": ada } }));
    expect(res.status).toBe(403);
  });
});

describe("refcount sweep", () => {
  test("unreferenced blobs past the grace period are deleted; referenced ones stay", async () => {
    const doc = await newDoc(db, ada);
    const keep = (await (await upload(ada, doc, new Uint8Array([...PNG, 1, 1]))).json()) as { hash: string };
    const orphan = (await (await upload(ada, doc, new Uint8Array([...PNG, 2, 2]))).json()) as { hash: string };
    const fresh = (await (await upload(ada, doc, new Uint8Array([...PNG, 3, 3]))).json()) as { hash: string };
    await runMutator(db, mutators.note.create({ id: crypto.randomUUID(), documentID: doc, anchor: anchor(keep.hash) }), { userID: ada });
    await db.sql`UPDATE blobs SET created_at = now() - interval '2 days' WHERE hash IN (${keep.hash}, ${orphan.hash})`;

    const { deleted } = await sweepBlobs(db, store);
    expect(deleted).toContain(orphan.hash);
    expect(deleted).not.toContain(keep.hash);
    expect(deleted).not.toContain(fresh.hash); // within grace: upload may be about to be referenced
    expect(await store.has(orphan.hash)).toBe(false);
    expect(await store.has(keep.hash)).toBe(true);

    // deleting the document drops its notes via cascade; the sweep then reclaims the blob
    await runMutator(db, mutators.document.delete({ id: doc }), { userID: ada });
    const second = await sweepBlobs(db, store);
    expect(second.deleted).toContain(keep.hash);
  });
});

describe("document thumbnails", () => {
  const bytes = (n: number) => new Uint8Array([...PNG, n]);
  const hashOf = async (r: Response) => ((await r.json()) as { hash: string }).hash;

  test("set after upload, signed for members only, never replaced by an older render, kept by the sweep", async () => {
    const doc = await newDoc(db, ada);
    const [l1, d1, l2, d2] = await Promise.all([1, 2, 3, 4].map(async (n) => hashOf(await upload(ada, doc, bytes(n)))));
    const missing = await runMutator(db, mutators.document.setThumbnail({ id: doc, light: "c".repeat(64), dark: d1, version: 1 }), { userID: ada });
    expect(missing.ok).toBe(false);
    expect((await runMutator(db, mutators.document.setThumbnail({ id: doc, light: l2, dark: d2, version: 2 }), { userID: ada })).ok).toBe(true);
    await runMutator(db, mutators.document.setThumbnail({ id: doc, light: l1, dark: d1, version: 1 }), { userID: ada });
    const [row] = await db.sql`SELECT thumb_light, thumb_dark, thumb_version FROM documents WHERE id = ${doc}`;
    expect(row).toEqual({ thumb_light: l2, thumb_dark: d2, thumb_version: 2 });
    expect((await runMutator(db, mutators.document.setThumbnail({ id: doc, light: l1, dark: d1, version: 3 }), { userID: bob })).ok).toBe(false);

    const urls = await blobs.thumbnailURLs(ada, [doc]);
    expect(urls[doc]!.light).toContain(l2);
    expect((await blobs.handle(new Request(urls[doc]!.dark))).status).toBe(200);
    expect(await blobs.thumbnailURLs(bob, [doc])).toEqual({});

    await db.sql`UPDATE blobs SET created_at = now() - interval '2 days' WHERE hash IN (${l1}, ${d1}, ${l2}, ${d2})`;
    const { deleted } = await sweepBlobs(db, store);
    expect(deleted).toEqual(expect.arrayContaining([l1, d1]));
    expect(deleted).not.toContain(l2);
    expect(deleted).not.toContain(d2);
  });
});

// Runs against the compose MinIO (or any S3) when S3_TEST_ENDPOINT is set.
const s3 = process.env.S3_TEST_ENDPOINT;
describe.skipIf(!s3)("S3 adapter", () => {
  test("put / has / get / delete", async () => {
    const st: BlobStore = new S3BlobStore({
      endpoint: s3!,
      bucket: process.env.S3_TEST_BUCKET ?? "parasocial",
      accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? "parasocial",
      secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? "parasocial-secret",
      prefix: `test-${crypto.randomUUID()}/`,
    });
    const hash = "c".repeat(64);
    expect(await st.has(hash)).toBe(false);
    await st.put(hash, PNG, "image/png");
    expect(await st.has(hash)).toBe(true);
    const body = await st.get(hash);
    expect(new Uint8Array(await new Response(body).arrayBuffer())).toEqual(PNG);
    await st.delete(hash);
    expect(await st.has(hash)).toBe(false);
  });
});
