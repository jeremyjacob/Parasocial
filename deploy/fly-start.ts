// Entrypoint for the Fly image (deploy/fly.Dockerfile): runs the whole stack on one machine, in the
// order deploy/docker-compose.yml's depends_on gives it. Caddy (the only public port) starts first and holds
// cold-start requests until their upstream answers (deploy/fly.Caddyfile); a closed port would make
// Fly's proxy back off for ~15 s. If any service exits, everything stops and the machine exits (Fly
// restarts it). On SIGINT/SIGTERM (Fly's auto-stop) Caddy stops first, then the rest in reverse, Postgres last.
import { mkdirSync, chownSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";

const env = process.env;
for (const k of ["DOMAIN", "ENGINE_HOST", "POSTGRES_PASSWORD", "APP_SECRET", "ZERO_API_KEY", "ZERO_ADMIN_PASSWORD", "POOL_TOKEN"]) {
  if (!env[k]) throw new Error(`fly-start: ${k} is not set`);
}

const repo = join(import.meta.dir, "..");
const PG_BIN = "/usr/lib/postgresql/17/bin";
const DATA = "/data";
const PGDATA = `${DATA}/pg`;
const DATABASE_URL = `postgres://parasocial:${encodeURIComponent(env.POSTGRES_PASSWORD!)}@127.0.0.1:5432/parasocial`;
const BUN_UID = 1000;

const ids = (user: string) => {
  const r = Bun.spawnSync(["id", "-u", user]).stdout.toString().trim();
  const g = Bun.spawnSync(["id", "-g", user]).stdout.toString().trim();
  return { uid: Number(r), gid: Number(g) };
};
const pg = ids("postgres");
const as = (user: string, cmd: string[]) => ["setpriv", `--reuid=${user}`, `--regid=${user}`, "--init-groups", ...cmd];

function dir(path: string, owner: { uid: number; gid: number }, mode = 0o755) {
  mkdirSync(path, { recursive: true, mode });
  chownSync(path, owner.uid, owner.gid);
}

function run(cmd: string[], opts: { env?: Record<string, string | undefined> } = {}) {
  const r = Bun.spawnSync(cmd, { env: { ...env, ...opts.env }, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`fly-start: ${cmd.join(" ")} exited ${r.exitCode}`);
}

async function until(what: string, ok: () => Promise<boolean> | boolean, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`fly-start: timed out waiting for ${what}`);
    await Bun.sleep(200);
  }
}
const responds = (url: string) => () =>
  fetch(url).then(
    (r) => r.status < 500,
    () => false,
  );

const started = performance.now();
const t = () => `${((performance.now() - started) / 1000).toFixed(1)}s`;

// Volume layout
dir(PGDATA, pg, 0o700);
dir(`${DATA}/zero`, { uid: BUN_UID, gid: BUN_UID });
dir(`${DATA}/blobs`, { uid: BUN_UID, gid: BUN_UID });

if (!existsSync(`${PGDATA}/PG_VERSION`)) {
  const pwfile = "/tmp/pgpw";
  writeFileSync(pwfile, env.POSTGRES_PASSWORD!, { mode: 0o600 });
  chownSync(pwfile, pg.uid, pg.gid);
  run(as("postgres", [`${PG_BIN}/initdb`, "-D", PGDATA, "-U", "parasocial", `--pwfile=${pwfile}`, "--auth=scram-sha-256", "-E", "UTF8"]));
  rmSync(pwfile);
}

const procs: { name: string; proc: Subprocess }[] = [];
let stopping = false;

function start(name: string, cmd: string[], extraEnv: Record<string, string | undefined> = {}) {
  const proc = Bun.spawn(cmd, { cwd: repo, env: { ...env, ...extraEnv }, stdout: "inherit", stderr: "inherit" });
  procs.push({ name, proc });
  proc.exited.then((code) => {
    if (stopping) return;
    console.error(`fly-start: ${name} exited (${code}); stopping`);
    shutdown(1);
  });
  return proc;
}

async function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  // postgres last (SIGINT = fast shutdown)
  const order = [...procs].reverse().sort((a, b) => Number(b.name === "caddy") - Number(a.name === "caddy"));
  for (const { name, proc } of order) {
    proc.kill(name === "postgres" ? "SIGINT" : "SIGTERM");
    const done = await Promise.race([proc.exited.then(() => true), Bun.sleep(name === "postgres" ? 25_000 : 8_000).then(() => false)]);
    if (!done) proc.kill("SIGKILL");
  }
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

try {
  start("caddy", ["caddy", "run", "--config", "deploy/fly.Caddyfile", "--adapter", "caddyfile"]);
  start(
    "postgres",
    as("postgres", [
      `${PG_BIN}/postgres`,
      "-D", PGDATA,
      "-c", "listen_addresses=127.0.0.1",
      "-c", "unix_socket_directories=/tmp",
      "-c", "wal_level=logical",
      "-c", "max_wal_senders=10",
      "-c", "max_replication_slots=10",
      "-c", "shared_buffers=1GB",
    ]),
  );
  await until("postgres", () => Bun.spawnSync([`${PG_BIN}/pg_isready`, "-q", "-h", "127.0.0.1", "-U", "parasocial", "-d", "postgres"]).exitCode === 0);
  const pgEnv = { PGPASSWORD: env.POSTGRES_PASSWORD };
  const hasDb = Bun.spawnSync([`${PG_BIN}/psql`, "-h", "127.0.0.1", "-U", "parasocial", "-d", "postgres", "-tAc", "SELECT 1 FROM pg_database WHERE datname='parasocial'"], { env: { ...env, ...pgEnv } });
  if (hasDb.stdout.toString().trim() !== "1") run([`${PG_BIN}/createdb`, "-h", "127.0.0.1", "-U", "parasocial", "parasocial"], { env: pgEnv });
  // zero-cache needs the parasocial_zero publication before it boots
  run(as("bun", ["bun", "packages/sync/src/server/migrate.ts"]), { env: { DATABASE_URL } });
  console.log(`fly-start: postgres ready (${t()})`);

  start("engine-pool", as("bun", ["bun", "packages/engine-pool/src/server.ts"]), {
    POOL_HOST: "127.0.0.1",
    POOL_PORT: "4000",
    POOL_MAX_DOCS: env.POOL_MAX_DOCS ?? "4",
    POOL_IDLE_MS: "300000",
  });

  start("app", as("bun", ["bun", "deploy/app-start.ts"]), {
    APP_ORIGIN: `https://${env.DOMAIN}`,
    ENGINE_ORIGIN: `https://${env.ENGINE_HOST}`,
    ORIGIN: `https://${env.DOMAIN}`,
    PORT: "3000",
    DATABASE_URL,
    ENGINE_POOL_URL: "http://127.0.0.1:4000",
    BLOB_DIR: `${DATA}/blobs`,
    HOME: "/home/bun",
  });

  start("zero-cache", as("bun", ["node", "/opt/zero/node_modules/.bin/zero-cache"]), {
    ZERO_UPSTREAM_DB: DATABASE_URL,
    ZERO_CVR_DB: DATABASE_URL,
    ZERO_CHANGE_DB: DATABASE_URL,
    ZERO_REPLICA_FILE: `${DATA}/zero/zero.db`,
    ZERO_APP_PUBLICATIONS: "parasocial_zero",
    ZERO_PORT: "4848",
    ZERO_MUTATE_URL: "http://127.0.0.1:3000/api/zero/mutate",
    ZERO_QUERY_URL: "http://127.0.0.1:3000/api/zero/query",
    ZERO_MUTATE_FORWARD_COOKIES: "true",
    ZERO_QUERY_FORWARD_COOKIES: "true",
    ZERO_MUTATE_API_KEY: env.ZERO_API_KEY,
    ZERO_QUERY_API_KEY: env.ZERO_API_KEY,
    ZERO_ENABLE_CRUD_MUTATIONS: "false",
    ZERO_LOG_LEVEL: "info",
    HOME: "/home/bun",
  });

  await until("app", responds("http://127.0.0.1:3000/"));
  await until("engine origin", responds("http://127.0.0.1:5174/"));
  await until("zero-cache", responds("http://127.0.0.1:4848/"));
  console.log(`fly-start: services ready (${t()})`);
} catch (e) {
  console.error(e);
  await shutdown(1);
}
