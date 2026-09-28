import type { Handle, ServerInit } from "@sveltejs/kit";
import { platform } from "$lib/server/platform";
import { agent } from "$lib/server/agent";
import { renderMeta } from "$lib/server/meta";
import { shareMeta } from "$lib/server/share";

// the built-in agent works handed-over notes in the background from startup
export const init: ServerInit = async () => {
  agent().catch((e) => console.error("agent: failed to start", e));
};

export const handle: Handle = async ({ event, resolve }) => {
  const p = await platform();
  // (re)starts it after a dev-server module reload; otherwise already running from init
  void agent().catch(() => {});
  event.locals.user = await p.resolveUser(event.request);
  // link-preview tags. Client-rendered pages (ssr = false) don't run their load before the shell
  // renders, so a share link's are looked up here; SSR pages may set locals.meta in their load.
  const shared = event.request.method === "GET" && event.url.pathname.match(/^\/s\/([^/]+)\/?$/);
  if (shared) event.locals.meta = await shareMeta(shared[1]!);
  const res = await resolve(event, {
    transformPageChunk: ({ html }) => html.replace("<!--meta-->", renderMeta(event.locals.meta, event.url, p.config.appOrigin)),
  });
  // the app is cross-origin isolated (engine iframe threads need it)
  res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  res.headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  return res;
};
