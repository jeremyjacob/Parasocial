/**
 * Test helpers. Each test file gets its own freshly migrated database on the
 * throwaway Postgres (TEST_DATABASE_URL, default: the container on :54329 —
 * see README "Tests"). Databases are named ps_test_* and dropped afterwards;
 * nothing else on the server is touched.
 */
import postgres from "postgres";
import { createDb, type Db } from "../src/server/db.ts";
import { migrate } from "../src/server/migrate.ts";
import { mutators } from "../src/mutators.ts";
import { runMutator } from "../src/server/zero.ts";
import type { MutatorContext } from "../src/types.ts";

export const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://test:test@localhost:54329/parasocial_test";

export type TestDb = Db & { name: string; url: string; drop(): Promise<void> };

export async function createTestDb(): Promise<TestDb> {
  const name = `ps_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = postgres(TEST_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(TEST_URL);
  url.pathname = `/${name}`;
  const db = createDb(url.toString(), { max: 5 });
  await migrate(db.sql);
  return {
    ...db,
    name,
    url: url.toString(),
    async drop() {
      await db.close();
      const a = postgres(TEST_URL, { max: 1, onnotice: () => {} });
      await a.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

export async function createUser(db: Db, name = "Ada", isAdmin = false): Promise<string> {
  const id = crypto.randomUUID();
  await db.sql`INSERT INTO users (id, name, avatar_seed, is_admin) VALUES (${id}, ${name}, ${id}, ${isAdmin})`;
  return id;
}

export async function createAgentSession(db: Db, userID: string, clientName = "Claude Code", label?: string) {
  const id = crypto.randomUUID();
  const r = await runMutator(db, mutators.agent.start({ id, clientName, label }), { userID });
  if (!r.ok) throw new Error(r.message);
  return id;
}

/** Runs a mutator and throws on application errors. */
export async function run(db: Db, mr: Parameters<typeof runMutator>[1], ctx: MutatorContext) {
  const r = await runMutator(db, mr, ctx);
  if (!r.ok) throw new Error(`${r.message} ${JSON.stringify(r.details)}`);
}

export async function newDoc(db: Db, userID: string, name = "Bracket") {
  const id = crypto.randomUUID();
  await run(db, mutators.document.create({ id, name }), { userID });
  return id;
}
