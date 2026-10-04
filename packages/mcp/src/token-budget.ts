// Fixed per-session context cost of the MCP server: every tool's definition as a client sees it
// (tools/list: name, description, JSON input schema, annotations) plus the server instructions.
// Agents pay this in every conversation before doing anything, so it has a budget
// (test/token-budget.test.ts; `bun scripts/mcp-token-budget.ts` prints the breakdown).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools, type Session, type ToolDeps } from "./tools";
import { registerApiReference } from "./api-reference";
import { ESSENTIALS, GUIDE } from "./instructions";

/** Rough token estimate (English prose and JSON average ~4 chars per token). */
export const approxTokens = (chars: number) => Math.round(chars / 4);

export type ToolCost = { name: string; description: number; schema: number; total: number };

/** Every tool's definition, measured as compact JSON (what tools/list sends). */
export async function measureToolList(): Promise<{ tools: ToolCost[]; total: number; instructions: { essentials: number; guide: number; total: number }; definitions: { name: string }[] }> {
  const session: Session = { id: "budget", userID: "u", clientID: "c", clientName: "budget", activeConfig: new Map(), lastVersion: new Map(), calls: [], noteCursors: new Map(), startedAt: 0 };
  const server = new McpServer({ name: "parasocial", version: "1" });
  // registration touches none of the dependencies
  registerTools(server, session, {} as ToolDeps);
  registerApiReference(server, session);
  const client = new Client({ name: "budget", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const { tools } = await client.listTools();
    const out = tools.map((t) => {
      const total = JSON.stringify(t).length;
      const description = (t.description ?? "").length;
      return { name: t.name, description, schema: total - description, total };
    });
    // each session gets the essentials and the guide once (instructions.ts); the dynamic tail
    // (session default, browser activity) is left out: it depends on the user
    return { tools: out, total: out.reduce((s, t) => s + t.total, 0), instructions: { essentials: ESSENTIALS.length, guide: GUIDE.length, total: ESSENTIALS.length + 2 + GUIDE.length }, definitions: tools };
  } finally {
    await client.close();
    await server.close();
  }
}
