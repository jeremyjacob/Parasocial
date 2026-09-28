import { redirect } from "@sveltejs/kit";
import { isMember, sharedDocument } from "$lib/server/share";

// (link-preview tags: hooks.server.ts, since this page renders client-side)
export const load = async ({ params, locals }) => {
  const d = await sharedDocument(params.token);
  // members get the full workspace
  if (d && locals.user && (await isMember(locals.user.userID, d.id))) redirect(303, `/d/${d.id}`);
  return { shared: d ? { id: d.id, name: d.name } : null, share: params.token };
};
