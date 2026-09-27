/**
 * Content-addressed blob store for authored binaries (note snapshots, document thumbnails).
 *
 *   upload first → get the sha256 → run the mutation that references it.
 *   note.create checks the blobs row exists and bumps its refcount, so a row
 *   never points at a missing blob. `sweepBlobs` recomputes refcounts from the
 *   actual references and deletes unreferenced blobs past a grace period.
 *
 * Reads go through signed URLs: HMAC(hash, documentID, expiry). A URL is only
 * signed for a document member, and only for blobs that document references
 * (or the caller's own not-yet-referenced uploads).
 *
 * Adapters: filesystem (compose default / dev) and S3-compatible (Bun.S3Client;
 * MinIO in compose, S3 or R2 when hosted).
 *
 * Routes (handle(), base path default /api/blobs):
 *   POST ?document=ID      raw body, content-type image/*  → { hash, size }
 *   POST sign              { documentID, hashes }          → { urls: { [hash]: url } }
 *   GET  :hash?doc&exp&sig                                  → bytes
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SHA256_RE, toHex } from "../util.ts";
import type { ServerConfig } from "./config.ts";
import type { Db } from "./db.ts";
import { checkOrigin, error, handle, HttpError, json, readJSON } from "./http.ts";

export interface BlobStore {
  has(hash: string): Promise<boolean>;
  put(hash: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** A readable body for the blob, or null if missing. */
  get(hash: string): Promise<ReadableStream<Uint8Array> | Blob | null>;
  delete(hash: string): Promise<void>;
}

export class FsBlobStore implements BlobStore {
  constructor(readonly root: string) {}
  private path(hash: string) {
    return join(this.root, hash.slice(0, 2), hash.slice(2, 4), hash);
  }
  async has(hash: string) {
    return stat(this.path(hash)).then(
      () => true,
      () => false,
    );
  }
  async put(hash: string, bytes: Uint8Array) {
    const p = this.path(hash);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${crypto.randomUUID()}.tmp`;
    await Bun.write(tmp, bytes);
    await rename(tmp, p); // atomic: readers never see a partial blob
  }
  async get(hash: string) {
    const f = Bun.file(this.path(hash));
    return (await f.exists()) ? f : null;
  }
  async delete(hash: string) {
    await rm(this.path(hash), { force: true });
  }
}

export type S3Options = {
  bucket: string;
  endpoint?: string | undefined;
  region?: string | undefined;
  accessKeyId: string;
  secretAccessKey: string;
  prefix?: string | undefined;
};

export class S3BlobStore implements BlobStore {
  readonly client: InstanceType<typeof Bun.S3Client>;
  private prefix: string;
  constructor(opts: S3Options) {
    this.client = new Bun.S3Client({
      bucket: opts.bucket,
      endpoint: opts.endpoint,
      region: opts.region ?? "us-east-1",
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
    });
    this.prefix = opts.prefix ?? "blobs/";
  }
  private key(hash: string) {
    return `${this.prefix}${hash}`;
  }
  has(hash: string) {
    return this.client.exists(this.key(hash));
  }
  async put(hash: string, bytes: Uint8Array, contentType: string) {
    await this.client.write(this.key(hash), bytes, { type: contentType });
  }
  async get(hash: string) {
    const f = this.client.file(this.key(hash));
    return (await f.exists()) ? f.stream() : null;
  }
  async delete(hash: string) {
    await this.client.delete(this.key(hash));
  }
}

/** Picks the adapter from env: S3_BUCKET → S3, else BLOB_DIR (default ./data/blobs). */
export function blobStoreFromEnv(env: Record<string, string | undefined> = process.env): BlobStore {
  if (env.S3_BUCKET) {
    return new S3BlobStore({
      bucket: env.S3_BUCKET,
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      accessKeyId: env.S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? "",
    });
  }
  return new FsBlobStore(env.BLOB_DIR ?? "./data/blobs");
}

// ───────────────────────────── signing ─────────────────────────────

const sign = (secret: string, hash: string, documentID: string, exp: number) =>
  createHmac("sha256", secret).update(`blob\n${hash}\n${documentID}\n${exp}`).digest("base64url");

/** Signs a read URL. Callers must have checked membership first (the `sign` route does). */
export function signBlobURL(
  config: Pick<ServerConfig, "secret" | "appOrigin">,
  a: { hash: string; documentID: string; ttlSeconds?: number; basePath?: string; now?: number },
): string {
  const exp = Math.floor((a.now ?? Date.now()) / 1000) + (a.ttlSeconds ?? 3600);
  const sig = sign(config.secret, a.hash, a.documentID, exp);
  const q = new URLSearchParams({ doc: a.documentID, exp: String(exp), sig });
  return `${config.appOrigin}${a.basePath ?? "/api/blobs"}/${a.hash}?${q}`;
}

export function verifyBlobSignature(
  secret: string,
  a: { hash: string; documentID: string; exp: number; sig: string; now?: number },
): "ok" | "expired" | "bad" {
  const expected = Buffer.from(sign(secret, a.hash, a.documentID, a.exp));
  const got = Buffer.from(a.sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return "bad";
  if (a.exp * 1000 < (a.now ?? Date.now())) return "expired";
  return "ok";
}

// ───────────────────────────── handlers ─────────────────────────────

const ALLOWED_TYPES = new Set(["image/png", "image/webp", "image/jpeg", "image/avif"]);
export const MAX_BLOB_BYTES = 10 * 1024 * 1024;

export function createBlobHandlers(deps: {
  db: Db;
  store: BlobStore;
  config: Pick<ServerConfig, "secret" | "appOrigin" | "engineOrigins">;
  resolveUser: (req: Request) => Promise<{ userID: string } | null>;
  basePath?: string;
}) {
  const { db, store, config } = deps;
  const basePath = deps.basePath ?? "/api/blobs";

  async function isMember(userID: string, documentID: string) {
    const [m] = await db.sql`SELECT 1 FROM document_members WHERE document_id = ${documentID} AND user_id = ${userID}`;
    return !!m;
  }

  async function upload(req: Request) {
    const user = await deps.resolveUser(req);
    if (!user) throw new HttpError(401, "Not signed in");
    const documentID = new URL(req.url).searchParams.get("document");
    if (!documentID || !(await isMember(user.userID, documentID))) throw new HttpError(403, "Not a member of this document");
    const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim();
    if (!ALLOWED_TYPES.has(type)) throw new HttpError(415, `Unsupported content type ${type || "(none)"}`);
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_BLOB_BYTES) throw new HttpError(413, "Blob too large");
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length > MAX_BLOB_BYTES) throw new HttpError(413, "Blob too large");
    if (bytes.length === 0) throw new HttpError(400, "Empty body");
    const hash = toHex(new Uint8Array(new Bun.CryptoHasher("sha256").update(bytes).digest()));
    // Store first, then the row: the row existing implies the bytes exist.
    if (!(await store.has(hash))) await store.put(hash, bytes, type);
    await db.sql`INSERT INTO blobs (hash, size, content_type, uploaded_by)
                 VALUES (${hash}, ${bytes.length}, ${type}, ${user.userID}) ON CONFLICT (hash) DO NOTHING`;
    return json({ hash, size: bytes.length });
  }

  async function signRoute(req: Request) {
    const user = await deps.resolveUser(req);
    if (!user) throw new HttpError(401, "Not signed in");
    const { documentID, hashes } = await readJSON<{ documentID: string; hashes: string[] }>(req);
    if (!documentID || !Array.isArray(hashes) || hashes.length > 500) throw new HttpError(400, "documentID and hashes[] required");
    if (!(await isMember(user.userID, documentID))) throw new HttpError(403, "Not a member of this document");
    const valid = hashes.filter((h) => SHA256_RE.test(h));
    const rows = await db.sql`
      SELECT b.hash FROM blobs b
      WHERE b.hash = ANY(${valid})
        AND (EXISTS (SELECT 1 FROM notes n WHERE n.document_id = ${documentID} AND n.snapshot_hash = b.hash)
             OR EXISTS (SELECT 1 FROM documents d WHERE d.id = ${documentID} AND b.hash IN (d.thumb_light, d.thumb_dark))
             OR (b.uploaded_by = ${user.userID} AND b.refcount = 0))`;
    const urls: Record<string, string> = {};
    for (const r of rows) urls[r.hash] = signBlobURL(config, { hash: r.hash, documentID, basePath });
    return json({ urls });
  }

  /** Signed thumbnail URLs for the documents list: { [documentID]: { light, dark } }, members only. */
  async function thumbnailURLs(userID: string, documentIDs: readonly string[]) {
    const rows = await db.sql`
      SELECT d.id, d.thumb_light, d.thumb_dark FROM documents d
      JOIN document_members m ON m.document_id = d.id AND m.user_id = ${userID}
      WHERE d.id = ANY(${documentIDs as string[]}) AND d.thumb_light IS NOT NULL AND d.thumb_dark IS NOT NULL`;
    // expiry snapped to the hour (valid 1–2 h), so the URLs, and the browser's cached images, stay stable
    const now = Math.floor(Date.now() / 3600_000) * 3600_000;
    const at = (hash: string, documentID: string) => signBlobURL(config, { hash, documentID, basePath, now, ttlSeconds: 7200 });
    const urls: Record<string, { light: string; dark: string }> = {};
    for (const r of rows) urls[r.id] = { light: at(r.thumb_light, r.id), dark: at(r.thumb_dark, r.id) };
    return urls;
  }

  async function thumbsRoute(req: Request) {
    const user = await deps.resolveUser(req);
    if (!user) throw new HttpError(401, "Not signed in");
    const { documentIDs } = await readJSON<{ documentIDs: string[] }>(req);
    if (!Array.isArray(documentIDs) || documentIDs.length > 500) throw new HttpError(400, "documentIDs[] required");
    return json({ urls: await thumbnailURLs(user.userID, documentIDs) });
  }

  async function read(req: Request, hash: string) {
    const u = new URL(req.url);
    const documentID = u.searchParams.get("doc") ?? "";
    const exp = Number(u.searchParams.get("exp"));
    const sig = u.searchParams.get("sig") ?? "";
    if (!SHA256_RE.test(hash) || !documentID || !Number.isFinite(exp)) return error(400, "Malformed blob URL");
    const v = verifyBlobSignature(config.secret, { hash, documentID, exp, sig });
    if (v === "bad") return error(403, "Bad signature");
    if (v === "expired") return error(410, "Link expired");
    const [row] = await db.sql`SELECT content_type FROM blobs WHERE hash = ${hash}`;
    const body = row ? await store.get(hash) : null;
    if (!body) return error(404, "Not found");
    const maxAge = Math.max(0, exp - Math.floor(Date.now() / 1000));
    return new Response(body, {
      headers: {
        "content-type": row!.content_type,
        "cache-control": `private, max-age=${maxAge}, immutable`,
        etag: `"${hash}"`,
        "cross-origin-resource-policy": "same-origin",
        "x-content-type-options": "nosniff",
      },
    });
  }

  const handleReq = handle(async (req: Request) => {
    const denied = checkOrigin(req, config);
    if (denied) return denied;
    const path = new URL(req.url).pathname;
    if (!path.startsWith(basePath)) return error(404, "Not found");
    const sub = path.slice(basePath.length).replace(/^\/+|\/+$/g, "");
    if (req.method === "POST" && sub === "") return upload(req);
    if (req.method === "POST" && sub === "sign") return signRoute(req);
    if (req.method === "POST" && sub === "thumbs") return thumbsRoute(req);
    if ((req.method === "GET" || req.method === "HEAD") && SHA256_RE.test(sub)) return read(req, sub);
    return error(404, "Not found");
  });

  return { handle: handleReq, thumbnailURLs };
}

/**
 * Refcount sweep: recompute refcounts from actual references (so cascaded
 * document deletes are accounted for), then delete unreferenced blobs older
 * than `graceMs` (uploads that were never referenced, or no longer are).
 * Run periodically (e.g. hourly) from the app server.
 */
export async function sweepBlobs(db: Db, store: BlobStore, opts: { graceMs?: number } = {}) {
  const grace = opts.graceMs ?? 24 * 3600_000;
  await db.sql`
    UPDATE blobs b SET refcount = coalesce(r.n, 0)
    FROM (SELECT b2.hash, ((SELECT count(*) FROM notes n WHERE n.snapshot_hash = b2.hash)
      + (SELECT count(*) FROM documents d WHERE b2.hash IN (d.thumb_light, d.thumb_dark)))::int AS n FROM blobs b2) r
    WHERE r.hash = b.hash AND b.refcount IS DISTINCT FROM coalesce(r.n, 0)`;
  const doomed = await db.sql`
    SELECT hash FROM blobs WHERE refcount = 0 AND created_at < ${new Date(Date.now() - grace)}`;
  const deleted: string[] = [];
  for (const { hash } of doomed) {
    // Delete the row first (guarded against a concurrent reference), then the bytes.
    const gone = await db.sql`DELETE FROM blobs WHERE hash = ${hash} AND refcount = 0
                              AND NOT EXISTS (SELECT 1 FROM notes WHERE snapshot_hash = ${hash})
                              AND NOT EXISTS (SELECT 1 FROM documents WHERE ${hash} IN (thumb_light, thumb_dark)) RETURNING hash`;
    if (gone.length) {
      await store.delete(hash);
      deleted.push(hash);
    }
  }
  return { deleted };
}
