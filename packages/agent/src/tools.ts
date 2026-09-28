// The built-in agent's tools are the MCP tools, called through an in-process MCP client, so it
// sees exactly what an external agent sees. Scoped to one document: document-management tools are
// left out and every call is pinned to the run's document.
import { dynamicTool, jsonSchema, type ToolSet, type JSONSchema7 } from "ai";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/** Not offered: other documents, blocking waits, and removing notes. The run has already claimed its note. */
export const EXCLUDED_TOOLS = new Set([
  "list_documents",
  "get_document_context",
  "open_document",
  "create_document",
  "rename_document",
  "duplicate_document",
  "delete_document",
  "export_document",
  "import_document",
  "wait_for_notes",
  "claim_note",
  "delete_note",
]);

type McpContent = { type: string; text?: string; data?: string; mimeType?: string; resource?: { uri: string; text?: string } };
type McpResult = { content?: McpContent[]; isError?: boolean };

export async function mcpToolSet(client: Client, documentID: string): Promise<ToolSet> {
  const { tools } = await client.listTools();
  const out: ToolSet = {};
  for (const t of tools) {
    if (EXCLUDED_TOOLS.has(t.name)) continue;
    const schema = structuredClone(t.inputSchema) as JSONSchema7 & { properties?: Record<string, unknown>; required?: string[] };
    const pinned = !!schema.properties && "document" in schema.properties;
    if (pinned) {
      delete schema.properties!.document;
      if (schema.required) schema.required = schema.required.filter((r: string) => r !== "document");
    }
    out[t.name] = dynamicTool({
      description: t.description ?? t.name,
      inputSchema: jsonSchema(schema),
      execute: async (input, { abortSignal }) => {
        const args = { ...(input as Record<string, unknown>), ...(pinned ? { document: documentID } : {}) };
        return (await client.callTool({ name: t.name, arguments: args }, undefined, { signal: abortSignal, timeout: 5 * 60_000 })) as McpResult;
      },
      toModelOutput: ({ output }) => toModelOutput(output as McpResult),
    });
  }
  return out;
}

/** MCP content → model content: text stays text, images (render) go to the model as images. */
export function toModelOutput(r: McpResult) {
  const parts = (r.content ?? []).map((c) => {
    if (c.type === "image" && c.data) return { type: "file" as const, mediaType: c.mimeType ?? "image/png", data: { type: "data" as const, data: c.data } };
    if (c.type === "text") return { type: "text" as const, text: c.text ?? "" };
    if (c.type === "resource") return { type: "text" as const, text: c.resource?.text ?? c.resource?.uri ?? "" };
    return { type: "text" as const, text: JSON.stringify(c) };
  });
  if (r.isError) return { type: "error-text" as const, value: parts.map((p) => (p.type === "text" ? p.text : "")).join("\n") || "Tool failed" };
  return { type: "content" as const, value: parts.length ? parts : [{ type: "text" as const, text: "(no output)" }] };
}
