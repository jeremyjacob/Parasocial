import { redirect, fail } from "@sveltejs/kit";
import { mcp } from "$lib/server/mcp";

export const load = async ({ locals }) => {
  if (!locals.user) redirect(303, "/signin?next=/settings");
  const agents = await (await mcp()).oauth.connections(locals.user.userID);
  return { agents: agents.map((a: any) => ({ id: a.id as string, name: a.client_name as string, connectedAt: new Date(a.connected_at).getTime(), lastUsed: new Date(a.last_used).getTime() })) };
};

export const actions = {
  revoke: async ({ request, locals }) => {
    if (!locals.user) return fail(401);
    const id = String((await request.formData()).get("client") ?? "");
    await (await mcp()).oauth.revokeClient(locals.user.userID, id);
    return { revoked: id };
  },
};
