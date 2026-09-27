/**
 * Tiny migration runner. Applies the migrations embedded from `packages/sync/migrations/*.sql`
 * (see scripts/gen-migrations.ts; a bundled server has no .sql files on disk) in filename
 * order, each in its own transaction, recording applied names in
 * `schema_migrations`. A Postgres advisory lock keeps concurrent app replicas
 * from racing at boot.
 *
 * CLI:  DATABASE_URL=postgres://… bun packages/sync/src/server/migrate.ts
 */
import postgres from "postgres";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MIGRATIONS } from "./migrations.gen";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));
const LOCK_ID = 0x7061_7261; // "para"

export async function migrate(
  sql: postgres.Sql,
  /** Read .sql files from this directory instead of the embedded copy (tests, tooling). */
  dir?: string,
  log: (msg: string) => void = () => {},
): Promise<string[]> {
  const migrations = dir ? await readMigrations(dir) : MIGRATIONS;
  const applied: string[] = [];
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK_ID})`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const done = new Set((await tx`SELECT name FROM schema_migrations`).map((r) => r.name as string));
    for (const [file, text] of migrations) {
      if (done.has(file)) continue;
      await tx.unsafe(text);
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
      applied.push(file);
      log(`applied ${file}`);
    }
  });
  return applied;
}

export async function readMigrations(dir: string = MIGRATIONS_DIR): Promise<(readonly [string, string])[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  return Promise.all(files.map(async (f) => [f, await Bun.file(join(dir, f)).text()] as const));
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL ?? process.env.ZERO_UPSTREAM_DB;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const applied = await migrate(sql, MIGRATIONS_DIR, console.log);
    console.log(applied.length ? `migrated (${applied.length})` : "up to date");
  } finally {
    await sql.end();
  }
}
