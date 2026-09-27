import { expect, test } from "bun:test";
import postgres from "postgres";
import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS } from "../src/server/migrations.gen";
import { readMigrations, migrate, MIGRATIONS_DIR } from "../src/server/migrate";
import { TEST_URL } from "./helpers";

test("embedded migrations match packages/sync/migrations (run scripts/gen-migrations.ts)", async () => {
  expect(MIGRATIONS.map(([n, s]) => [n, s])).toEqual((await readMigrations()).map(([n, s]) => [n, s]));
});

test("0005 moves parts/ scripts and version snapshots to studios/; 0006 resolves AwaitingReview notes", async () => {
  const name = `ps_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = postgres(TEST_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(TEST_URL);
  url.pathname = `/${name}`;
  const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
  const before = await mkdtemp(join(tmpdir(), "ps-migrations-"));
  try {
    for (const [f] of MIGRATIONS) if (f < "0005") await cp(join(MIGRATIONS_DIR, f), join(before, f));
    await migrate(sql, before);
    await sql`INSERT INTO users (id, name, avatar_seed) VALUES ('u', 'Ada', 'u')`;
    await sql`INSERT INTO documents (id, name, owner_id) VALUES ('d', 'Case', 'u')`;
    for (const path of ["parts/case.ts", "lib/holes.ts"])
      await sql`INSERT INTO scripts (id, document_id, path, content, content_hash, version) VALUES (${path}, 'd', ${path}, '', '', 1)`;
    const snapshot = { scripts: { "parts/case.ts": "a", "lib/holes.ts": "b" }, params: { configurations: [] } };
    await sql`INSERT INTO versions (id, document_id, number, kind, message, snapshot) VALUES ('v', 'd', 1, 'script', 'x', ${sql.json(snapshot)})`;

    await sql`INSERT INTO notes (id, document_id, anchor, status) VALUES ('n', 'd', '{}', 'AwaitingReview')`;

    expect(await migrate(sql)).toEqual(["0005_studios.sql", "0006_drop_awaiting_review.sql"]);
    expect((await sql`SELECT status FROM notes`)[0]!.status).toBe("Resolved");
    expect((await sql`SELECT path FROM scripts ORDER BY path`).map((r) => r.path)).toEqual(["lib/holes.ts", "studios/case.ts"]);
    const [v] = await sql`SELECT snapshot FROM versions`;
    expect(v!.snapshot).toEqual({ scripts: { "studios/case.ts": "a", "lib/holes.ts": "b" }, params: { configurations: [] } });
    const err = await sql`INSERT INTO scripts (id, document_id, path, content, content_hash, version) VALUES ('p', 'd', 'parts/x.ts', '', '', 1)`.then(() => null, (e: Error) => e);
    expect(err?.message).toContain("scripts_path_check");
  } finally {
    await sql.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
    await rm(before, { recursive: true, force: true });
  }
}, 30_000);
