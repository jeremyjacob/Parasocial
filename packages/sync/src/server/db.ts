/**
 * Database access: one postgres.js pool plus Zero's ZQL wrapper over it. The
 * ZQL database is what server-side mutators run against (same interface the
 * client has), and raw SQL (`db.sql`) is used for server-only tables.
 */
import postgres from "postgres";
import { zeroPostgresJS } from "@rocicorp/zero/server/adapters/postgresjs";
import { schema } from "../schema.ts";

export type Db = {
  sql: postgres.Sql;
  zql: ReturnType<typeof zeroPostgresJS<typeof schema>>;
  close(): Promise<void>;
};

export function createDb(urlOrSql: string | postgres.Sql, opts: { max?: number } = {}): Db {
  const sql =
    typeof urlOrSql === "string"
      ? postgres(urlOrSql, { max: opts.max ?? 10, onnotice: () => {}, idle_timeout: 30 })
      : urlOrSql;
  const zql = zeroPostgresJS(schema, sql);
  return { sql, zql, close: () => sql.end() };
}
