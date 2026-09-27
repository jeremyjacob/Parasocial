/**
 * One-stop wiring for the app server. Build once at startup, then each
 * SvelteKit `+server.ts` is a one-liner:
 *
 *   // src/lib/server/platform.ts
 *   import { createPlatform } from "@parasocial/sync/server";
 *   export const platform = await createPlatform();          // reads env, runs migrations
 *
 *   // src/routes/api/zero/mutate/+server.ts
 *   export const POST = ({ request }) => platform.mutate(request);
 *
 * See packages/sync/README.md for the full route table.
 */
import { createAuth } from "./auth.ts";
import { blobStoreFromEnv, createBlobHandlers, sweepBlobs, type BlobStore } from "./blobs.ts";
import { loadConfig, type ServerConfig } from "./config.ts";
import { createDb, type Db } from "./db.ts";
import { migrate } from "./migrate.ts";
import { createVersionHandlers } from "./versions.ts";
import { createMutateHandler, createQueryHandler } from "./zero.ts";
import { createZipHandlers } from "./zip.ts";

export type PlatformOptions = {
  config?: ServerConfig;
  db?: Db;
  store?: BlobStore;
  /** Apply pending migrations at startup (default true). */
  migrate?: boolean;
  /** Run the blob refcount sweep on an interval (ms). 0 disables. Default hourly. */
  sweepIntervalMs?: number;
};

export async function createPlatform(opts: PlatformOptions = {}) {
  const config = opts.config ?? loadConfig();
  const db = opts.db ?? createDb(config.databaseURL);
  if (opts.migrate !== false) await migrate(db.sql);
  const store = opts.store ?? blobStoreFromEnv();

  const auth = createAuth({ db, config });
  const resolveUser = auth.resolveUser;
  const blobs = createBlobHandlers({ db, store, config, resolveUser });
  const zip = createZipHandlers({ db, config, resolveUser });
  const versions = createVersionHandlers({ db, config, resolveUser });

  const sweepMs = opts.sweepIntervalMs ?? 3600_000;
  const timer = sweepMs > 0 ? setInterval(() => sweepBlobs(db, store).catch((e) => console.error("blob sweep failed", e)), sweepMs) : null;
  timer?.unref?.();

  return {
    config,
    db,
    store,
    resolveUser,
    /** POST /api/zero/mutate  (ZERO_MUTATE_URL) */
    mutate: createMutateHandler({ db, config, resolveUser }),
    /** POST /api/zero/query   (ZERO_QUERY_URL) */
    query: createQueryHandler({ config, resolveUser }),
    /** GET|POST /api/auth/[...path] */
    auth: auth.handle,
    /** GET|POST /api/blobs/[...path] */
    blobs: blobs.handle,
    /** GET /api/documents/:id/export, POST /api/documents/import */
    documents: zip.handle,
    /** GET /api/versions/:id */
    versions: versions.handle,
    async close() {
      if (timer) clearInterval(timer);
      await db.close();
    },
  };
}

export type Platform = Awaited<ReturnType<typeof createPlatform>>;

export { createAuth, SESSION_COOKIE } from "./auth.ts";
export { createBlobHandlers, FsBlobStore, S3BlobStore, signBlobURL, sweepBlobs, verifyBlobSignature, type BlobStore } from "./blobs.ts";
export { loadConfig, type ServerConfig } from "./config.ts";
export { createDb, type Db } from "./db.ts";
export { checkOrigin } from "./http.ts";
export { migrate } from "./migrate.ts";
export { readVersion } from "./versions.ts";
export { createMutateHandler, createQueryHandler, runMutator, runMutatorOrThrow, type RunResult } from "./zero.ts";
export { buildDocumentZip, exportDocument, importDocument, parseDocumentZip, readDocumentDir } from "./zip.ts";
