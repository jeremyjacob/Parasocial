import { redirect, fail } from "@sveltejs/kit";
import { deleteAgentSettings, getAgentSettings, loadAgentCredentials, PROVIDERS, saveAgentSettings, SettingsError, testProvider, type Provider } from "@parasocial/agent";
import { agent } from "$lib/server/agent";
import { mcp } from "$lib/server/mcp";
import { platform } from "$lib/server/platform";

export const load = async ({ locals }) => {
  if (!locals.user) redirect(303, "/signin?next=/settings");
  const p = await platform();
  const agents = await (await mcp()).oauth.connections(locals.user.userID);
  return {
    agents: agents.map((a: any) => ({ id: a.id as string, name: a.client_name as string, connectedAt: new Date(a.connected_at).getTime(), lastUsed: new Date(a.last_used).getTime() })),
    builtinAgent: await getAgentSettings(p.db, locals.user.userID),
  };
};

export const actions = {
  revoke: async ({ request, locals }) => {
    if (!locals.user) return fail(401);
    const id = String((await request.formData()).get("client") ?? "");
    await (await mcp()).oauth.revokeClient(locals.user.userID, id);
    return { revoked: id };
  },

  saveAgent: async ({ request, locals }) => {
    if (!locals.user) return fail(401);
    const f = await request.formData();
    const provider = String(f.get("provider") ?? "") as Provider;
    const apiKey = f.get("apiKey");
    const p = await platform();
    try {
      if (!PROVIDERS.includes(provider)) throw new SettingsError("Pick a provider.");
      await saveAgentSettings(p.db, p.config.secret, locals.user.userID, {
        provider,
        model: String(f.get("model") ?? ""),
        baseURL: String(f.get("baseURL") ?? "") || null,
        // an empty key field keeps the stored key; "Remove key" sends clearKey
        apiKey: f.get("clearKey") ? "" : typeof apiKey === "string" && apiKey.trim() ? apiKey : undefined,
      });
    } catch (e) {
      if (e instanceof SettingsError) return fail(400, { agentError: e.message });
      throw e;
    }
    // agent pickup waits for a provider: start on this user's waiting notes now, not at the next sweep
    void agent().then((d) => d.scan());
    return { agentSaved: true };
  },

  removeAgent: async ({ locals }) => {
    if (!locals.user) return fail(401);
    await deleteAgentSettings((await platform()).db, locals.user.userID);
    return { agentRemoved: true };
  },

  /** One tiny request to the saved provider, so a wrong key or model shows up here rather than on a note. */
  testAgent: async ({ locals }) => {
    if (!locals.user) return fail(401);
    const p = await platform();
    const creds = await loadAgentCredentials(p.db, p.config.secret, locals.user.userID);
    if (!creds) return fail(400, { agentError: "Save your provider first." });
    const error = await testProvider(creds);
    if (error) return fail(400, { agentError: error });
    return { agentTested: true };
  },
};
