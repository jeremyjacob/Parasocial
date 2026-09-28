import type { Handle, ServerInit } from "@sveltejs/kit";
import { platform } from "$lib/server/platform";
import { agent } from "$lib/server/agent";

// the built-in agent works handed-over notes in the background from startup
export const init: ServerInit = async () => {
  agent().catch((e) => console.error("agent: failed to start", e));
};

export const handle: Handle = async ({ event, resolve }) => {
  const p = await platform();
  // (re)starts it after a dev-server module reload; otherwise already running from init
  void agent().catch(() => {});
  event.locals.user = await p.resolveUser(event.request);
  const res = await resolve(event);
  // the app is cross-origin isolated (engine iframe threads need it)
  res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  res.headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  return res;
};
