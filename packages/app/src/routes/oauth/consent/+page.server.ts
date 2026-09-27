import { redirect, error } from "@sveltejs/kit";
import { mcp } from "$lib/server/mcp";

export const load = async ({ url, locals }) => {
  if (!locals.user) redirect(303, `/signin?next=${encodeURIComponent(url.pathname + url.search)}`);
  const v = await (await mcp()).oauth.validateAuthorize(url.searchParams);
  if ("error" in v) return { error: v.error };
  const doc = new URL(v.resource).searchParams.get("document");
  return { clientName: v.client.name, redirectHost: new URL(v.redirect).host, document: doc };
};

export const actions = {
  default: async ({ request, url, locals }) => {
    if (!locals.user) error(401, "Sign in first");
    const form = await request.formData();
    const approve = form.get("decision") === "approve";
    const to = await (await mcp()).oauth.decide(locals.user.userID, url.searchParams, approve).catch((e: Error) => error(400, e.message));
    redirect(303, to);
  },
};
