import type { Handle } from "@sveltejs/kit";
import { platform } from "$lib/server/platform";

export const handle: Handle = async ({ event, resolve }) => {
  const p = await platform();
  event.locals.user = await p.resolveUser(event.request);
  const res = await resolve(event);
  // the app is cross-origin isolated (engine iframe threads need it)
  res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  res.headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  return res;
};
