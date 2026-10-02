// Server-side document access for MCP tools (membership-checked reads straight from Postgres;
// writes go through the shared mutators via runMutator).
import type { Db } from "@parasocial/sync/server";

export class AccessError extends Error {}

export type DocState = {
  id: string;
  name: string;
  units: string;
  scripts: { path: string; content: string; version: number; contentHash: string }[];
  configurations: { id: string; name: string; overrides: { part: string; name: string; expression: string; value: unknown }[] }[];
};

export async function requireMember(db: Db, userID: string, documentID: string, min: "viewer" | "editor" = "viewer") {
  const [m] = await db.sql`SELECT role FROM document_members WHERE document_id = ${documentID} AND user_id = ${userID}`;
  if (!m) throw new AccessError(`No document ${documentID}, or you don't have access. Use list_documents.`);
  if (min === "editor" && m.role === "viewer") throw new AccessError("You have view-only access to this document.");
  return m.role as string;
}

export async function loadDoc(db: Db, userID: string, documentID: string): Promise<DocState> {
  await requireMember(db, userID, documentID);
  const [[d], scripts, cfgs, ovs] = await Promise.all([
    db.sql`SELECT id, name, units FROM documents WHERE id = ${documentID}`,
    db.sql`SELECT path, content, version, content_hash FROM scripts WHERE document_id = ${documentID} ORDER BY path`,
    db.sql`SELECT id, name FROM configurations WHERE document_id = ${documentID} ORDER BY created_at`,
    db.sql`SELECT configuration_id, part, name, expression, value FROM param_overrides WHERE document_id = ${documentID}`,
  ]);
  const byConfig = new Map<string, any[]>();
  for (const o of ovs) {
    const list = byConfig.get(o.configuration_id) ?? [];
    list.push({ part: o.part, name: o.name, expression: o.expression, value: o.value });
    byConfig.set(o.configuration_id, list);
  }
  return {
    id: d.id,
    name: d.name,
    units: d.units,
    scripts: scripts.map((s: any) => ({ path: s.path, content: s.content, version: Number(s.version), contentHash: s.content_hash })),
    configurations: cfgs.map((c: any) => ({ id: c.id, name: c.name, overrides: byConfig.get(c.id) ?? [] })),
  };
}

export function overridesFor(d: DocState, configurationID: string | null) {
  const cfg = d.configurations.find((c) => c.id === configurationID);
  const out: Record<string, Record<string, string | number>> = {};
  for (const o of cfg?.overrides ?? []) (out[o.part] ??= {})[o.name] = o.expression;
  return out;
}

export const scriptMap = (d: DocState) => Object.fromEntries(d.scripts.map((s) => [s.path, s.content]));
