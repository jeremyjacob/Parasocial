// Container entrypoint for the app image: the SvelteKit server (:3000) and the engine origin (:5174)
// side by side, like scripts/dev.ts. If either exits, the container exits and gets restarted.
import { join } from "node:path";

const repo = join(import.meta.dir, "..");
const engine = Bun.spawn(["bun", join(repo, "packages/runtime/src/server/serve.ts")], {
  env: { ...process.env, ENGINE_PORT: process.env.ENGINE_PORT ?? "5174", ENGINE_HOSTNAME: "0.0.0.0", APP_ORIGINS: process.env.APP_ORIGIN },
  stdout: "inherit",
  stderr: "inherit",
});
// svelte-adapter-bun's 10 s idle timeout drops quiet streams (slow MCP tool calls); 255 is Bun's max
const app = Bun.spawn(["bun", "build/index.js"], { cwd: join(repo, "packages/app"), env: { ...process.env, IDLE_TIMEOUT: process.env.IDLE_TIMEOUT ?? "120" }, stdout: "inherit", stderr: "inherit" });
const stop = () => (engine.kill(), app.kill());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const code = await Promise.race([engine.exited, app.exited]);
stop();
process.exit(code || 1);
