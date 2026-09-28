import { getAgentSettings } from "@parasocial/agent";
import { mcp } from "$lib/server/mcp";
import { platform } from "$lib/server/platform";

export const load = async ({ locals }) => {
  const p = await platform();
  // whether "Hand to agent" can run on this user's provider
  const agentConfigured = locals.user ? !!(await getAgentSettings(p.db, locals.user.userID)) : false;
  // whether a coding agent (Claude Code, Codex, …) has signed in over MCP; with neither, nothing can build models
  const mcpConnected = locals.user ? (await (await mcp()).oauth.connections(locals.user.userID)).length > 0 : false;
  return { user: locals.user, agentConfigured, mcpConnected, engineURL: p.config.engineOrigins[0] ?? "http://localhost:5174" };
};
