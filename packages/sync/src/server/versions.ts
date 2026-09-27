/**
 * Version contents. Zero syncs version metadata only (PLAN §9 Loading); the
 * scripts of a version are fetched on demand when it's opened in History or
 * via MCP `read_version`, from the server-only script_contents table.
 *
 *   GET {base}/:versionID           → { version, scripts: { [path]: content } }
 *   GET {base}/:versionID?path=p    → { version, scripts: { [p]: content } }
 */
import { zql, type Version } from "../schema.ts";
import type { ServerConfig } from "./config.ts";
import type { Db } from "./db.ts";
import { checkOrigin, error, handle, HttpError, json } from "./http.ts";

export async function readVersion(
  db: Db,
  versionID: string,
  userID: string,
  path?: string,
): Promise<{ version: Version; scripts: Record<string, string> }> {
  const version = await db.zql.run(zql.versions.where("id", versionID).one());
  if (!version) throw new HttpError(404, "Version not found");
  const [m] = await db.sql`SELECT 1 FROM document_members WHERE document_id = ${version.documentID} AND user_id = ${userID}`;
  if (!m) throw new HttpError(404, "Version not found"); // don't reveal existence to non-members
  const wanted = Object.entries(version.snapshot.scripts).filter(([p]) => !path || p === path);
  if (path && wanted.length === 0) throw new HttpError(404, `${path} is not in v${version.number}`);
  const rows = await db.sql`SELECT hash, content FROM script_contents WHERE hash = ANY(${wanted.map(([, h]) => h)})`;
  const byHash = new Map(rows.map((r) => [r.hash as string, r.content as string]));
  const scripts: Record<string, string> = {};
  for (const [p, h] of wanted) {
    const c = byHash.get(h);
    if (c === undefined) throw new HttpError(500, `Contents of ${p} in v${version.number} are missing`);
    scripts[p] = c;
  }
  return { version, scripts };
}

export function createVersionHandlers(deps: {
  db: Db;
  config: Pick<ServerConfig, "appOrigin" | "engineOrigins">;
  resolveUser: (req: Request) => Promise<{ userID: string } | null>;
  basePath?: string;
}) {
  const basePath = deps.basePath ?? "/api/versions";
  return {
    handle: handle(async (req) => {
      const denied = checkOrigin(req, deps.config);
      if (denied) return denied;
      if (req.method !== "GET") return error(405, "Method not allowed");
      const user = await deps.resolveUser(req);
      if (!user) return error(401, "Not signed in");
      const url = new URL(req.url);
      const id = decodeURIComponent(url.pathname.slice(basePath.length).replace(/^\/+|\/+$/g, ""));
      if (!id || id.includes("/")) return error(404, "Not found");
      const out = await readVersion(deps.db, id, user.userID, url.searchParams.get("path") ?? undefined);
      // Not cached: a params version's metadata can still change while its burst is coalescing.
      return json(out);
    }),
  };
}
