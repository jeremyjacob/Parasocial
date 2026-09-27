// MCP (§7): streamable HTTP, OAuth bearer tokens. Agents' edits go through the same mutators.
import { mcp } from "$lib/server/mcp";
const handle = async ({ request }: { request: Request }) => (await mcp()).handle(request);
export const GET = handle;
export const POST = handle;
export const DELETE = handle;
