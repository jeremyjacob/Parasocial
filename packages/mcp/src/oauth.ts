// OAuth 2.1 authorization server for MCP (§3 Accounts and auth, MCP authorization spec):
// protected-resource + AS metadata, dynamic client registration (RFC 7591), authorization code
// with mandatory PKCE S256, long-lived (non-rotating, sliding) refresh tokens, revocation.
// Public clients only. Refresh tokens don't rotate: clients like Codex run several processes off
// one stored credential, and rotation + reuse detection kept signing them all out.
// Users sign in with their passkey and approve on the consent screen (a SvelteKit page).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "@parasocial/sync/server";

export type OAuthConfig = { appOrigin: string };

const ACCESS_TTL = 60 * 60 * 1000; // 1 h
const REFRESH_TTL = 30 * 24 * 60 * 60 * 1000; // 30 d
const CODE_TTL = 5 * 60 * 1000;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const token = (n = 32) => randomBytes(n).toString("base64url");
const b64url = (buf: Buffer) => buf.toString("base64url");

export type TokenInfo = { userID: string; clientID: string; clientName: string; resource: string | null; tokenID: string };

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
}
const oauthError = (error: string, description: string, status = 400) => jsonRes({ error, error_description: description }, status);

/** Redirect URIs we accept: https anywhere, or http on loopback (native clients such as Claude Code). */
function validRedirect(u: string) {
  try {
    const url = new URL(u);
    if (url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/** RFC 8252 §7.3: loopback redirects may use any port. */
function redirectMatches(registered: string[], uri: string) {
  if (registered.includes(uri)) return true;
  try {
    const u = new URL(uri);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return false;
    return registered.some((r) => {
      const x = new URL(r);
      return x.hostname === u.hostname && x.pathname === u.pathname && x.protocol === u.protocol;
    });
  } catch {
    return false;
  }
}

export function createOAuth(deps: { db: Db; config: OAuthConfig }) {
  const { sql } = deps.db;
  const origin = deps.config.appOrigin;

  const resourceMetadata = () => ({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    resource_name: "Parasocial",
  });

  const asMetadata = () => ({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
  });

  async function register(req: Request) {
    const body = (await req.json().catch(() => null)) as { client_name?: string; redirect_uris?: string[]; token_endpoint_auth_method?: string } | null;
    if (!body || !Array.isArray(body.redirect_uris) || !body.redirect_uris.length) return oauthError("invalid_redirect_uri", "redirect_uris is required");
    if (body.redirect_uris.length > 10 || !body.redirect_uris.every(validRedirect)) return oauthError("invalid_redirect_uri", "redirect URIs must be https, or http on localhost");
    if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== "none") return oauthError("invalid_client_metadata", "only public clients (token_endpoint_auth_method=none) are supported");
    const id = `client_${token(16)}`;
    const name = (body.client_name ?? "MCP client").slice(0, 100);
    await sql`INSERT INTO oauth_clients (id, client_name, redirect_uris, metadata) VALUES (${id}, ${name}, ${sql.json(body.redirect_uris)}, ${sql.json(body as any)})`;
    return jsonRes({ client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: body.redirect_uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }, 201);
  }

  async function client(id: string | null) {
    if (!id) return null;
    const [c] = await sql`SELECT id, client_name, redirect_uris FROM oauth_clients WHERE id = ${id}`;
    return c ? { id: c.id as string, name: c.client_name as string, redirectURIs: c.redirect_uris as string[] } : null;
  }

  /**
   * Validate an authorization request. Returns the parsed request, or an error to show on
   * the consent page (errors about the redirect URI must never redirect).
   */
  async function validateAuthorize(params: URLSearchParams) {
    const c = await client(params.get("client_id"));
    if (!c) return { error: "Unknown client. Reconnect the agent so it can register again." } as const;
    const redirect = params.get("redirect_uri") ?? c.redirectURIs[0];
    if (!redirect || !redirectMatches(c.redirectURIs, redirect)) return { error: "The redirect address doesn't match this client's registration." } as const;
    if (params.get("response_type") !== "code") return { error: "Unsupported response type.", redirect } as const;
    const challenge = params.get("code_challenge");
    if (!challenge || params.get("code_challenge_method") !== "S256") return { error: "This client didn't use PKCE (S256), which is required.", redirect } as const;
    return { client: c, redirect, challenge, state: params.get("state"), resource: params.get("resource") ?? `${origin}/mcp` } as const;
  }

  /** The user approved (or denied) on the consent page. Returns the redirect URL. */
  async function decide(userID: string, params: URLSearchParams, approve: boolean): Promise<string> {
    const v = await validateAuthorize(params);
    if ("error" in v) throw new Error(v.error);
    const url = new URL(v.redirect);
    if (v.state) url.searchParams.set("state", v.state);
    if (!approve) {
      url.searchParams.set("error", "access_denied");
      return url.toString();
    }
    const code = token();
    await sql`INSERT INTO oauth_tokens (id, client_id, user_id, kind, token_hash, code_challenge, redirect_uri, resource, expires_at)
              VALUES (${token(12)}, ${v.client.id}, ${userID}, 'code', ${sha256(code)}, ${v.challenge}, ${v.redirect}, ${v.resource}, ${new Date(Date.now() + CODE_TTL)})`;
    url.searchParams.set("code", code);
    url.searchParams.set("iss", origin);
    return url.toString();
  }

  async function issue(clientID: string, userID: string, resource: string | null, family: string) {
    const access = token();
    const refresh = token();
    await sql`INSERT INTO oauth_tokens (id, client_id, user_id, kind, token_hash, resource, family, expires_at) VALUES
      (${token(12)}, ${clientID}, ${userID}, 'access', ${sha256(access)}, ${resource}, ${family}, ${new Date(Date.now() + ACCESS_TTL)}),
      (${token(12)}, ${clientID}, ${userID}, 'refresh', ${sha256(refresh)}, ${resource}, ${family}, ${new Date(Date.now() + REFRESH_TTL)})`;
    return jsonRes({ access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: "mcp" });
  }

  async function tokenEndpoint(req: Request) {
    const form = new URLSearchParams(await req.text());
    const grant = form.get("grant_type");
    const clientID = form.get("client_id");
    if (grant === "authorization_code") {
      const code = form.get("code") ?? "";
      const verifier = form.get("code_verifier") ?? "";
      const [row] = await sql`UPDATE oauth_tokens SET revoked_at = now() WHERE token_hash = ${sha256(code)} AND kind = 'code' AND revoked_at IS NULL RETURNING *`;
      if (!row || new Date(row.expires_at) < new Date()) return oauthError("invalid_grant", "code is invalid, used or expired");
      if (clientID && row.client_id !== clientID) return oauthError("invalid_grant", "code was issued to another client");
      if (form.get("redirect_uri") && form.get("redirect_uri") !== row.redirect_uri) return oauthError("invalid_grant", "redirect_uri mismatch");
      const expected = b64url(createHash("sha256").update(verifier).digest());
      const a = Buffer.from(expected),
        b = Buffer.from(String(row.code_challenge ?? ""));
      if (!verifier || a.length !== b.length || !timingSafeEqual(a, b)) return oauthError("invalid_grant", "PKCE verification failed");
      return issue(row.client_id, row.user_id, row.resource, token(12));
    }
    if (grant === "refresh_token") {
      const rt = form.get("refresh_token") ?? "";
      const [row] = await sql`SELECT * FROM oauth_tokens WHERE token_hash = ${sha256(rt)} AND kind = 'refresh'`;
      if (!row || row.revoked_at) return oauthError("invalid_grant", "refresh token is invalid or revoked");
      if (new Date(row.expires_at) < new Date()) return oauthError("invalid_grant", "refresh token expired");
      if (clientID && row.client_id !== clientID) return oauthError("invalid_grant", "refresh token was issued to another client");
      // no rotation: hand back the same refresh token and slide its expiry
      await sql`UPDATE oauth_tokens SET expires_at = ${new Date(Date.now() + REFRESH_TTL)} WHERE id = ${row.id}`;
      const access = token();
      await sql`INSERT INTO oauth_tokens (id, client_id, user_id, kind, token_hash, resource, family, expires_at)
                VALUES (${token(12)}, ${row.client_id}, ${row.user_id}, 'access', ${sha256(access)}, ${row.resource}, ${row.family}, ${new Date(Date.now() + ACCESS_TTL)})`;
      return jsonRes({ access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL / 1000, refresh_token: rt, scope: "mcp" });
    }
    return oauthError("unsupported_grant_type", "use authorization_code or refresh_token");
  }

  async function revoke(req: Request) {
    const form = new URLSearchParams(await req.text());
    const t = form.get("token");
    if (t) await sql`UPDATE oauth_tokens SET revoked_at = now() WHERE token_hash = ${sha256(t)} AND revoked_at IS NULL`;
    return new Response(null, { status: 200 });
  }

  /** Bearer token → identity, or null. */
  async function authenticate(req: Request): Promise<TokenInfo | null> {
    const h = req.headers.get("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return null;
    const [row] = await sql`SELECT t.id, t.user_id, t.client_id, t.resource, c.client_name FROM oauth_tokens t JOIN oauth_clients c ON c.id = t.client_id
                            WHERE t.token_hash = ${sha256(m[1])} AND t.kind = 'access' AND t.revoked_at IS NULL AND t.expires_at > now()`;
    return row ? { userID: row.user_id, clientID: row.client_id, clientName: row.client_name, resource: row.resource, tokenID: row.id } : null;
  }

  /** 401 for /mcp, pointing at the protected-resource metadata (MCP authorization spec). */
  function unauthorized(message = "Sign in required") {
    return new Response(JSON.stringify({ error: "invalid_token", error_description: message }), {
      status: 401,
      headers: { "Content-Type": "application/json", "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` },
    });
  }

  /** Connected agents for settings: clients with live tokens for this user. */
  async function connections(userID: string) {
    // refresh tokens don't rotate, so the latest access token is what marks "last used"
    return sql`SELECT c.id, c.client_name, min(t.created_at) AS connected_at, max(t.created_at) AS last_used
               FROM oauth_tokens t JOIN oauth_clients c ON c.id = t.client_id
               WHERE t.user_id = ${userID} AND t.kind IN ('access', 'refresh')
                 AND EXISTS (SELECT 1 FROM oauth_tokens r WHERE r.client_id = c.id AND r.user_id = ${userID} AND r.kind = 'refresh' AND r.revoked_at IS NULL AND r.expires_at > now())
               GROUP BY c.id, c.client_name ORDER BY last_used DESC`;
  }

  async function revokeClient(userID: string, clientID: string) {
    await sql`UPDATE oauth_tokens SET revoked_at = now() WHERE user_id = ${userID} AND client_id = ${clientID} AND revoked_at IS NULL`;
    await sql`UPDATE agent_sessions SET status = 'disconnected' WHERE user_id = ${userID} AND oauth_client_id = ${clientID}`;
  }

  /** Route handler for /.well-known/* and /oauth/* (except the consent page itself). */
  async function handle(req: Request): Promise<Response | null> {
    const u = new URL(req.url);
    const p = u.pathname;
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version" };
    if (req.method === "OPTIONS" && (p.startsWith("/.well-known/") || p.startsWith("/oauth/"))) return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "GET, POST, OPTIONS" } });
    const withCors = (r: Response) => {
      for (const [k, v] of Object.entries(cors)) r.headers.set(k, v);
      return r;
    };
    if (p.startsWith("/.well-known/oauth-protected-resource")) return withCors(jsonRes(resourceMetadata()));
    if (p.startsWith("/.well-known/oauth-authorization-server") || p.startsWith("/.well-known/openid-configuration")) return withCors(jsonRes(asMetadata()));
    if (p === "/oauth/register" && req.method === "POST") return withCors(await register(req));
    if (p === "/oauth/token" && req.method === "POST") return withCors(await tokenEndpoint(req));
    if (p === "/oauth/revoke" && req.method === "POST") return withCors(await revoke(req));
    return null;
  }

  return { handle, validateAuthorize, decide, authenticate, unauthorized, connections, revokeClient, client };
}

export type OAuth = ReturnType<typeof createOAuth>;
