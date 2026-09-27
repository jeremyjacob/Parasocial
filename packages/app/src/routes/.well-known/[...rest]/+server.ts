import { mcp } from "$lib/server/mcp";
export const GET = async ({ request }) => (await (await mcp()).oauth.handle(request)) ?? new Response("not found", { status: 404 });
export const OPTIONS = GET;
