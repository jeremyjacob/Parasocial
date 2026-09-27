// /oauth/register, /oauth/token, /oauth/revoke (public clients, called by MCP clients directly)
import { mcp } from "$lib/server/mcp";
const h = async ({ request }: { request: Request }) => (await (await mcp()).oauth.handle(request)) ?? new Response("not found", { status: 404 });
export const POST = h;
export const OPTIONS = h;
