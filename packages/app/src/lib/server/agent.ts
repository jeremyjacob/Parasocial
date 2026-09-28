import { createAgentDispatcher, type AgentDispatcher } from "@parasocial/agent";
import { mcp } from "./mcp";
import { platform } from "./platform";

// one per process; the global survives dev-server module reloads, which stop the old one (below)
const g = globalThis as { __agentDispatcher?: Promise<AgentDispatcher> };

/** The built-in agent's dispatcher: shares the MCP engine pool and note wake-ups. */
export function agent(): Promise<AgentDispatcher> {
  return (g.__agentDispatcher ??= Promise.all([platform(), mcp()]).then(([p, m]) =>
    createAgentDispatcher({ db: p.db, store: p.store, pool: m.pool, noteEvents: m.noteEvents, config: { appOrigin: p.config.appOrigin, secret: p.config.secret } }),
  ));
}

if (import.meta.hot) {
  import.meta.hot.dispose(async () => {
    const d = g.__agentDispatcher;
    g.__agentDispatcher = undefined;
    await (await d)?.stop();
  });
}
