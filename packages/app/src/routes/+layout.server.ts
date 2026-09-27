import { platform } from "$lib/server/platform";

export const load = async ({ locals }) => {
  const p = await platform();
  return { user: locals.user, engineURL: p.config.engineOrigins[0] ?? "http://localhost:5174" };
};
