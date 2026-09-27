import { redirect } from "@sveltejs/kit";
export const load = ({ locals, url }) => {
  if (!locals.user) redirect(303, `/signin?next=${encodeURIComponent(url.pathname)}`);
};
