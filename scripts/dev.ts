// Local development: Postgres + zero-cache (docker), migrations, engine origin (:5174),
// and the SvelteKit app (:5173). Ctrl-C stops the host processes; containers keep running
// (`docker compose -f deploy/dev-compose.yml down` to stop them).
import { $ } from "bun";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
export const DEV_ENV = {
  DOMAIN: "localhost",
  APP_ORIGIN: "http://localhost:5173",
  ENGINE_ORIGIN: "http://localhost:5174",
  DATABASE_URL: "postgres://parasocial:dev@localhost:54330/parasocial",
  APP_SECRET: "dev-secret-dev-secret-dev-secret-dev-secret",
  ZERO_API_KEY: "dev-zero-key",
  BLOB_DIR: join(root, ".data/blobs"),
  ZERO_CACHE_URL: "http://localhost:4848",
};

if (import.meta.main) {
  const compose = ["-f", join(root, "deploy/dev-compose.yml")];
  await $`docker compose ${compose} up -d --wait postgres`.quiet();
  await $`bun ${join(root, "packages/sync/src/server/migrate.ts")}`.env({ ...process.env, ...DEV_ENV });
  await $`docker compose ${compose} up -d zero-cache`.quiet();
  const env = { ...process.env, ...DEV_ENV };
  // the engine origin rebuilds its bundle on start; `--watch` restarts it when runtime sources change
  const engine = Bun.spawn(["bun", "--watch", join(root, "packages/runtime/src/server/serve.ts")], { env: { ...env, ENGINE_PORT: "5174", APP_ORIGINS: DEV_ENV.APP_ORIGIN }, stdout: "inherit", stderr: "inherit" });
  const pool = Bun.spawn(["bun", "--watch", join(root, "packages/engine-pool/src/server.ts")], { env: { ...env, POOL_PORT: "5190" }, stdout: "inherit", stderr: "inherit" });
  const app = Bun.spawn(["bun", "--bun", "vite", "dev", "--port", "5173", "--strictPort"], { cwd: join(root, "packages/app"), env, stdout: "inherit", stderr: "inherit" });
  const stop = () => (engine.kill(), pool.kill(), app.kill(), process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await Promise.race([engine.exited, pool.exited, app.exited]);
  stop();
}
