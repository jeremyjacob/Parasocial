// MCP endpoint (§7): streamable HTTP at /mcp, OAuth-authenticated, many concurrent sessions.
// Each session is an agent session (client name + optional label) with its own avatar in the
// workspace, its own active configuration, and claims that keep it from colliding with others.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { mutators } from "@parasocial/sync";
import { runMutator, type Db, type BlobStore } from "@parasocial/sync/server";
import { PoolClient } from "@parasocial/engine-pool/client";
import { registerTools, type Session } from "./tools";
import { INSTRUCTIONS } from "./instructions";
import { createOAuth, type OAuth } from "./oauth";
import { API_DTS, EXAMPLES } from "./resources";

export type McpDeps = { db: Db; store: BlobStore; config: { appOrigin: string; secret: string }; pool?: PoolClient };

type Live = { transport: WebStandardStreamableHTTPServerTransport; server: McpServer; session: Session; userID: string };

export function createMcp(deps: McpDeps) {
  const oauth: OAuth = createOAuth({ db: deps.db, config: deps.config });
  const pool = deps.pool ?? new PoolClient();
  const live = new Map<string, Live>();

  function buildServer(session: Session) {
    const server = new McpServer({ name: "parasocial", version: "1.0.0" }, { instructions: INSTRUCTIONS, capabilities: { tools: {}, resources: {} } });
    registerTools(server, session, { db: deps.db, pool, store: deps.store, config: deps.config });
    server.registerResource("agent-instructions", "parasocial://instructions", { title: "Agent instructions", mimeType: "text/markdown" }, async (uri) => ({ contents: [{ uri: uri.href, text: INSTRUCTIONS, mimeType: "text/markdown" }] }));
    server.registerResource("api-types", "parasocial://api/parasocial.d.ts", { title: "Modeling API types (parasocial)", mimeType: "text/plain" }, async (uri) => ({ contents: [{ uri: uri.href, text: API_DTS, mimeType: "text/plain" }] }));
    server.registerResource("examples", "parasocial://examples", { title: "Example parts", mimeType: "text/markdown" }, async (uri) => ({ contents: [{ uri: uri.href, text: EXAMPLES, mimeType: "text/markdown" }] }));
    server.registerResource("document-settings", "parasocial://document", { title: "Default document settings", mimeType: "application/json" }, async (uri) => {
      const id = session.defaultDocument;
      const [d] = id ? await deps.db.sql`SELECT id, name, units, settings FROM documents d JOIN document_members m ON m.document_id = d.id AND m.user_id = ${session.userID} WHERE d.id = ${id}` : [];
      return { contents: [{ uri: uri.href, text: JSON.stringify(d ?? { note: "No default document for this session" }, null, 2), mimeType: "application/json" }] };
    });
    return server;
  }

  /** POST/GET/DELETE /mcp */
  async function handle(req: Request): Promise<Response> {
    const auth = await oauth.authenticate(req);
    if (!auth) return oauth.unauthorized();
    const url = new URL(req.url);
    const sid = req.headers.get("mcp-session-id");
    if (sid) {
      const l = live.get(sid);
      if (!l) return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found; reinitialize" }, id: null }), { status: 404, headers: { "Content-Type": "application/json" } });
      if (l.userID !== auth.userID) return new Response("forbidden", { status: 403 });
      touch(l.session);
      return l.transport.handleRequest(req);
    }
    if (req.method !== "POST") return new Response("Missing mcp-session-id", { status: 400 });

    // new session: document default and label come from the URL the agent was given (§7).
    // The same client + label reconnecting is the same agent (keeps its avatar and claims).
    const label = url.searchParams.get("label") ?? undefined;
    const [prior] = await deps.db.sql`SELECT id FROM agent_sessions WHERE user_id = ${auth.userID} AND oauth_client_id = ${auth.clientID} AND label IS NOT DISTINCT FROM ${label ?? null}
      ORDER BY EXISTS (SELECT 1 FROM notes n WHERE n.claimed_by = agent_sessions.id AND n.removed_at IS NULL) DESC, last_seen_at DESC LIMIT 1`;
    const session: Session = {
      id: prior?.id ?? crypto.randomUUID(),
      userID: auth.userID,
      clientID: auth.clientID,
      clientName: auth.clientName,
      label,
      defaultDocument: url.searchParams.get("document") ?? undefined,
      activeConfig: new Map(),
      lastVersion: new Map(),
      calls: [],
    };
    const server = buildServer(session);
    const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: async (id) => {
        live.set(id, { transport, server, session, userID: auth.userID });
        // the agent shows up in the workspace (stacked avatars)
        let documentID = session.defaultDocument;
        if (documentID) {
          const [m] = await deps.db.sql`SELECT 1 FROM document_members WHERE document_id = ${documentID} AND user_id = ${auth.userID}`;
          if (!m) documentID = undefined;
        }
        await runMutator(deps.db, mutators.agent.start({ id: session.id, clientName: session.clientName, label: session.label, documentID, oauthClientID: session.clientID } as any), { userID: auth.userID });
      },
      onsessionclosed: async (id) => close(id),
    });
    await server.connect(transport);
    return transport.handleRequest(req);
  }

  function touch(s: Session) {
    deps.db.sql`UPDATE agent_sessions SET last_seen_at = ${Date.now()} WHERE id = ${s.id}`.catch(() => {});
  }

  async function close(id: string) {
    // id: transport session id
    const l = live.get(id);
    live.delete(id);
    if (!l) return;
    await l.server.close().catch(() => {});
    // another connection of the same agent is still open: it keeps its claims
    if ([...live.values()].some((x) => x.session.id === l.session.id)) return;
    id = l.session.id;
    // release claims so other agents can pick the notes up
    await deps.db.sql`UPDATE notes SET claimed_by = NULL, status = CASE WHEN status = 'AgentWorking' THEN 'Open' ELSE status END WHERE claimed_by = ${id}`.catch(() => {});
    await runMutator(deps.db, mutators.agent.setStatus({ id, status: "disconnected" } as any), { userID: l.userID }).catch(() => {});
  }

  // sessions that stop talking are disconnected after 30 minutes
  const sweep = setInterval(async () => {
    const stale = await deps.db.sql`SELECT id FROM agent_sessions WHERE status <> 'disconnected' AND last_seen_at < ${Date.now() - 30 * 60_000}`.catch(() => []);
    for (const r of stale as any[]) {
      const t = [...live].find(([, l]) => l.session.id === r.id)?.[0];
      if (t) await close(t);
      else await deps.db.sql`UPDATE agent_sessions SET status = 'disconnected' WHERE id = ${r.id}`.catch(() => {});
    }
  }, 60_000);
  (sweep as any).unref?.();

  return { handle, oauth, sessions: () => live.size };
}

export type Mcp = ReturnType<typeof createMcp>;
