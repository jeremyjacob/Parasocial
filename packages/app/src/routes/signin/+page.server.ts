import { redirect } from "@sveltejs/kit";
import { platform } from "$lib/server/platform";

export const load = async ({ locals, url }) => {
  if (locals.user) redirect(303, url.searchParams.get("next") ?? "/");
  const p = await platform();
  const [{ n }] = await p.db.sql`SELECT count(*)::int AS n FROM users`;
  const [s] = await p.db.sql`SELECT signup_mode FROM instance_settings WHERE id = 1`;
  return { needsSetup: n === 0, signupMode: (s?.signup_mode as string | undefined) ?? "open", invite: url.searchParams.get("invite") };
};
