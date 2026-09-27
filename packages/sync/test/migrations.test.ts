import { expect, test } from "bun:test";
import { MIGRATIONS } from "../src/server/migrations.gen";
import { readMigrations } from "../src/server/migrate";

test("embedded migrations match packages/sync/migrations (run scripts/gen-migrations.ts)", async () => {
  expect(MIGRATIONS.map(([n, s]) => [n, s])).toEqual((await readMigrations()).map(([n, s]) => [n, s]));
});
