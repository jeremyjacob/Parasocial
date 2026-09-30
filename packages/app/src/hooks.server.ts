import type { Handle, ServerInit } from "@sveltejs/kit";
import { dev } from "$app/environment";
import { platform } from "$lib/server/platform";
import { agent } from "$lib/server/agent";
import { renderMeta } from "$lib/server/meta";
import { shareMeta } from "$lib/server/share";

// the built-in agent works handed-over notes in the background from startup
export const init: ServerInit = async () => {
  agent().catch((e) => console.error("agent: failed to start", e));
};

// SvelteKit's CSRF origin check, minus the OAuth endpoints: native MCP clients (Codex, Claude Code)
// POST form-encoded token/revoke requests without an Origin header, which the built-in check rejects.
const FORM_TYPES = ["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"];
const CSRF_EXEMPT = new Set(["/oauth/token", "/oauth/revoke"]);
function crossSiteForm({ request, url }: { request: Request; url: URL }) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method) || CSRF_EXEMPT.has(url.pathname)) return false;
  const type = request.headers.get("content-type")?.split(";", 1)[0]!.trim().toLowerCase() ?? "";
  return FORM_TYPES.includes(type) && request.headers.get("origin") !== url.origin;
}

export const handle: Handle = async ({ event, resolve }) => {
  if (!dev && crossSiteForm(event)) return new Response(`Cross-site ${event.request.method} form submissions are forbidden`, { status: 403 });
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
