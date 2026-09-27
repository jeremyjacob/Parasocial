/**
 * Passkey-only accounts (PLAN §3 Accounts and auth), on SimpleWebAuthn.
 *
 *  - Sign up with a name only, then create a passkey (discoverable / resident
 *    key, so sign-in needs no username and works with autofill).
 *  - The first account becomes admin. The admin picks open sign-up or invite links.
 *  - More passkeys can be added from settings; the last one can't be removed.
 *  - Sessions: random token in an HttpOnly cookie; only sha256(token) is stored.
 *
 * All endpoints live under one handler (`auth.handle`), routed by the path
 * after `basePath` (default /api/auth):
 *
 *   GET  session                 → { user, signupMode, needsSetup }
 *   POST register/options        { name, invite? } → creation options
 *   POST register/verify         { response }      → { user } + session cookie
 *   POST login/options                              → request options (empty allowCredentials: discoverable/autofill)
 *   POST login/verify            { response }      → { user } + session cookie
 *   POST logout
 *   GET  passkeys                                  → your passkeys
 *   POST passkeys/options                          → creation options (excludes existing)
 *   POST passkeys/verify         { response, name? }
 *   POST passkeys/delete         { id }
 *   GET  admin/settings | POST admin/settings { signupMode: "open" | "invite" }
 *   GET  admin/invites  | POST admin/invites  { ttlDays? } → { token, url, expiresAt }
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { toHex } from "../util.ts";
import type { ServerConfig } from "./config.ts";
import type { Db } from "./db.ts";
import { checkOrigin, cookie, error, handle, HttpError, json, parseCookies, readJSON } from "./http.ts";

export const SESSION_COOKIE = "ps_session";
const CHALLENGE_COOKIE = "ps_webauthn";
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const INVITE_TTL_DAYS = 7;

export type SessionUser = { userID: string; name: string; isAdmin: boolean };
export type SignupMode = "open" | "invite";

type AuthConfig = Pick<ServerConfig, "rpID" | "rpName" | "appOrigin" | "engineOrigins" | "sessionTTLms" | "secureCookies">;

const randomToken = (bytes = 32) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
const sha256 = (s: string) => toHex(new Uint8Array(new Bun.CryptoHasher("sha256").update(s).digest()));

export function createAuth({ db, config, basePath = "/api/auth" }: { db: Db; config: AuthConfig; basePath?: string }) {
  const { sql } = db;

  // ── sessions ──

  async function createSession(userID: string, req: Request): Promise<string> {
    const token = randomToken();
    const expires = new Date(Date.now() + config.sessionTTLms);
    await sql`INSERT INTO auth_sessions (id, user_id, expires_at, user_agent)
              VALUES (${sha256(token)}, ${userID}, ${expires}, ${req.headers.get("user-agent")})`;
    return cookie(SESSION_COOKIE, token, { secure: config.secureCookies, maxAgeSec: Math.floor(config.sessionTTLms / 1000) });
  }

  /** Resolves the signed-in user from the session cookie. Use for every authenticated handler. */
  async function resolveUser(req: Request): Promise<SessionUser | null> {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (!token) return null;
    const [row] = await sql`
      SELECT u.id, u.name, u.is_admin FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ${sha256(token)} AND s.expires_at > now()`;
    return row ? { userID: row.id, name: row.name, isAdmin: row.is_admin } : null;
  }

  async function requireUser(req: Request) {
    const u = await resolveUser(req);
    if (!u) throw new HttpError(401, "Not signed in");
    return u;
  }

  // ── challenges ──

  async function putChallenge(c: { kind: "register" | "login" | "add"; challenge: string; userID?: string; name?: string; inviteHash?: string | null }) {
    const id = randomToken(16);
    await sql`DELETE FROM webauthn_challenges WHERE expires_at < now()`;
    await sql`INSERT INTO webauthn_challenges (id, kind, challenge, user_id, name, invite_hash, expires_at)
              VALUES (${id}, ${c.kind}, ${c.challenge}, ${c.userID ?? null}, ${c.name ?? null}, ${c.inviteHash ?? null},
                      ${new Date(Date.now() + CHALLENGE_TTL_MS)})`;
    return cookie(CHALLENGE_COOKIE, id, { secure: config.secureCookies, maxAgeSec: CHALLENGE_TTL_MS / 1000 });
  }

  /** Single use: the row is deleted as it's read. */
  async function takeChallenge(req: Request, kind: "register" | "login" | "add") {
    const id = parseCookies(req)[CHALLENGE_COOKIE];
    if (!id) throw new HttpError(400, "No pending passkey ceremony; start again");
    const [row] = await sql`DELETE FROM webauthn_challenges WHERE id = ${id} RETURNING *`;
    if (!row || row.kind !== kind || new Date(row.expires_at).getTime() < Date.now())
      throw new HttpError(400, "Passkey ceremony expired; start again");
    return row as { challenge: string; user_id: string | null; name: string | null; invite_hash: string | null };
  }

  const clearChallenge = cookie(CHALLENGE_COOKIE, "", { secure: config.secureCookies, maxAgeSec: 0 });

  // ── instance settings / invites ──

  async function signupMode(): Promise<SignupMode> {
    const [r] = await sql`SELECT signup_mode FROM instance_settings WHERE id = 1`;
    return (r?.signup_mode ?? "open") as SignupMode;
  }

  async function userCount(tx: typeof sql = sql): Promise<number> {
    const [r] = await tx`SELECT count(*)::int AS n FROM users`;
    return r!.n;
  }

  async function checkInvite(token: string | undefined, tx: typeof sql = sql): Promise<string> {
    if (!token) throw new HttpError(403, "Sign-up on this instance is by invite only");
    const hash = sha256(token);
    const [inv] = await tx`SELECT * FROM invites WHERE token_hash = ${hash} AND redeemed_at IS NULL AND expires_at > now()`;
    if (!inv) throw new HttpError(403, "This invite link is invalid, used or expired");
    return hash;
  }

  // ── handlers ──

  const routes: Record<string, (req: Request) => Promise<Response>> = {
    "GET session": async (req) => {
      const user = await resolveUser(req);
      return json({ user, signupMode: await signupMode(), needsSetup: (await userCount()) === 0 });
    },

    "POST register/options": async (req) => {
      const body = await readJSON<{ name?: string; invite?: string }>(req);
      const name = (body.name ?? "").trim();
      if (name.length < 1 || name.length > 100) throw new HttpError(400, "Enter a name (1–100 characters)");
      let inviteHash: string | null = null;
      if ((await userCount()) > 0 && (await signupMode()) === "invite") inviteHash = await checkInvite(body.invite);
      const userID = crypto.randomUUID();
      const options = await generateRegistrationOptions({
        rpName: config.rpName,
        rpID: config.rpID,
        userName: name,
        userDisplayName: name,
        userID: new TextEncoder().encode(userID),
        attestationType: "none",
        authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
      });
      const setCookie = await putChallenge({ kind: "register", challenge: options.challenge, userID, name, inviteHash });
      return json(options, { headers: { "set-cookie": setCookie } });
    },

    "POST register/verify": async (req) => {
      const { response } = await readJSON<{ response: RegistrationResponseJSON }>(req);
      const ch = await takeChallenge(req, "register");
      const v = await verifyRegistrationResponse({
        response,
        expectedChallenge: ch.challenge,
        expectedOrigin: config.appOrigin,
        expectedRPID: config.rpID,
        requireUserVerification: false,
      }).catch((e) => {
        throw new HttpError(400, `Passkey verification failed: ${e.message}`);
      });
      if (!v.verified) throw new HttpError(400, "Passkey verification failed");
      const { credential, credentialDeviceType, credentialBackedUp } = v.registrationInfo;
      const userID = ch.user_id!;
      const user = await sql.begin(async (tx) => {
        // Serialise sign-ups so exactly one first account becomes admin.
        const [settings] = await tx`SELECT signup_mode FROM instance_settings WHERE id = 1 FOR UPDATE`;
        const first = (await userCount(tx)) === 0;
        if (!first && settings!.signup_mode === "invite") {
          if (!ch.invite_hash) throw new HttpError(403, "Sign-up on this instance is by invite only");
          const used = await tx`UPDATE invites SET redeemed_by = NULL, redeemed_at = now()
                                WHERE token_hash = ${ch.invite_hash} AND redeemed_at IS NULL AND expires_at > now() RETURNING token_hash`;
          if (used.length === 0) throw new HttpError(403, "This invite link is invalid, used or expired");
        }
        await tx`INSERT INTO users (id, name, avatar_seed, is_admin) VALUES (${userID}, ${ch.name!}, ${userID}, ${first})`;
        if (ch.invite_hash) await tx`UPDATE invites SET redeemed_by = ${userID} WHERE token_hash = ${ch.invite_hash}`;
        await tx`INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_type, backed_up, name)
                 VALUES (${credential.id}, ${userID}, ${Buffer.from(credential.publicKey)}, ${credential.counter},
                         ${tx.array(credential.transports ?? [])}, ${credentialDeviceType}, ${credentialBackedUp}, ${"Passkey"})`;
        return { userID, name: ch.name!, isAdmin: first };
      });
      const headers = new Headers({ "content-type": "application/json" });
      headers.append("set-cookie", await createSession(userID, req));
      headers.append("set-cookie", clearChallenge);
      return new Response(JSON.stringify({ user }), { headers });
    },

    "POST login/options": async () => {
      const options = await generateAuthenticationOptions({ rpID: config.rpID, userVerification: "preferred", allowCredentials: [] });
      const setCookie = await putChallenge({ kind: "login", challenge: options.challenge });
      return json(options, { headers: { "set-cookie": setCookie } });
    },

    "POST login/verify": async (req) => {
      const { response } = await readJSON<{ response: AuthenticationResponseJSON }>(req);
      const ch = await takeChallenge(req, "login");
      const [pk] = await sql`SELECT * FROM passkeys WHERE id = ${response?.id ?? ""}`;
      if (!pk) throw new HttpError(400, "Unknown passkey. It may belong to another site or a deleted account.");
      const v = await verifyAuthenticationResponse({
        response,
        expectedChallenge: ch.challenge,
        expectedOrigin: config.appOrigin,
        expectedRPID: config.rpID,
        requireUserVerification: false,
        credential: { id: pk.id, publicKey: new Uint8Array(pk.public_key), counter: Number(pk.counter), transports: pk.transports },
      }).catch((e) => {
        throw new HttpError(400, `Passkey verification failed: ${e.message}`);
      });
      if (!v.verified) throw new HttpError(400, "Passkey verification failed");
      await sql`UPDATE passkeys SET counter = ${v.authenticationInfo.newCounter}, last_used_at = now(),
                backed_up = ${v.authenticationInfo.credentialBackedUp} WHERE id = ${pk.id}`;
      const [u] = await sql`SELECT id, name, is_admin FROM users WHERE id = ${pk.user_id}`;
      const headers = new Headers({ "content-type": "application/json" });
      headers.append("set-cookie", await createSession(pk.user_id, req));
      headers.append("set-cookie", clearChallenge);
      return new Response(JSON.stringify({ user: { userID: u!.id, name: u!.name, isAdmin: u!.is_admin } }), { headers });
    },

    "POST logout": async (req) => {
      const token = parseCookies(req)[SESSION_COOKIE];
      if (token) await sql`DELETE FROM auth_sessions WHERE id = ${sha256(token)}`;
      return json({ ok: true }, { headers: { "set-cookie": cookie(SESSION_COOKIE, "", { secure: config.secureCookies, maxAgeSec: 0 }) } });
    },

    "GET passkeys": async (req) => {
      const u = await requireUser(req);
      const rows = await sql`SELECT id, name, device_type, backed_up, created_at, last_used_at FROM passkeys
                             WHERE user_id = ${u.userID} ORDER BY created_at`;
      return json({
        passkeys: rows.map((r) => ({
          id: r.id,
          name: r.name,
          synced: r.device_type === "multiDevice",
          backedUp: r.backed_up,
          createdAt: r.created_at,
          lastUsedAt: r.last_used_at,
        })),
      });
    },

    "POST passkeys/options": async (req) => {
      const u = await requireUser(req);
      const existing = await sql`SELECT id, transports FROM passkeys WHERE user_id = ${u.userID}`;
      const options = await generateRegistrationOptions({
        rpName: config.rpName,
        rpID: config.rpID,
        userName: u.name,
        userDisplayName: u.name,
        userID: new TextEncoder().encode(u.userID),
        attestationType: "none",
        excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports })),
        authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
      });
      const setCookie = await putChallenge({ kind: "add", challenge: options.challenge, userID: u.userID });
      return json(options, { headers: { "set-cookie": setCookie } });
    },

    "POST passkeys/verify": async (req) => {
      const u = await requireUser(req);
      const { response, name } = await readJSON<{ response: RegistrationResponseJSON; name?: string }>(req);
      const ch = await takeChallenge(req, "add");
      if (ch.user_id !== u.userID) throw new HttpError(400, "Passkey ceremony belongs to another session");
      const v = await verifyRegistrationResponse({
        response,
        expectedChallenge: ch.challenge,
        expectedOrigin: config.appOrigin,
        expectedRPID: config.rpID,
        requireUserVerification: false,
      }).catch((e) => {
        throw new HttpError(400, `Passkey verification failed: ${e.message}`);
      });
      if (!v.verified) throw new HttpError(400, "Passkey verification failed");
      const { credential, credentialDeviceType, credentialBackedUp } = v.registrationInfo;
      await sql`INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_type, backed_up, name)
                VALUES (${credential.id}, ${u.userID}, ${Buffer.from(credential.publicKey)}, ${credential.counter},
                        ${sql.array(credential.transports ?? [])}, ${credentialDeviceType}, ${credentialBackedUp}, ${name?.slice(0, 100) ?? "Passkey"})`;
      return json({ ok: true, id: credential.id }, { headers: { "set-cookie": clearChallenge } });
    },

    "POST passkeys/delete": async (req) => {
      const u = await requireUser(req);
      const { id } = await readJSON<{ id: string }>(req);
      const done = await sql.begin(async (tx) => {
        const rows = await tx`SELECT id FROM passkeys WHERE user_id = ${u.userID} FOR UPDATE`;
        if (!rows.some((r) => r.id === id)) throw new HttpError(404, "Passkey not found");
        if (rows.length === 1) throw new HttpError(400, "You can't remove your only passkey: there is no other way to sign in");
        await tx`DELETE FROM passkeys WHERE id = ${id}`;
        return true;
      });
      return json({ ok: done });
    },

    "GET admin/settings": async (req) => {
      await requireAdmin(req);
      return json({ signupMode: await signupMode() });
    },

    "POST admin/settings": async (req) => {
      await requireAdmin(req);
      const { signupMode: mode } = await readJSON<{ signupMode: SignupMode }>(req);
      if (mode !== "open" && mode !== "invite") throw new HttpError(400, "signupMode must be open or invite");
      await sql`UPDATE instance_settings SET signup_mode = ${mode}, updated_at = now() WHERE id = 1`;
      return json({ signupMode: mode });
    },

    "GET admin/invites": async (req) => {
      await requireAdmin(req);
      const rows = await sql`SELECT i.created_at, i.expires_at, i.redeemed_at, u.name AS redeemed_by
                             FROM invites i LEFT JOIN users u ON u.id = i.redeemed_by ORDER BY i.created_at DESC`;
      return json({ invites: rows });
    },

    "POST admin/invites": async (req) => {
      const admin = await requireAdmin(req);
      const body = await readJSON<{ ttlDays?: number }>(req).catch(() => ({}) as { ttlDays?: number });
      const days = Math.min(Math.max(body.ttlDays ?? INVITE_TTL_DAYS, 1), 90);
      const token = randomToken(24);
      const expiresAt = new Date(Date.now() + days * 86400_000);
      await sql`INSERT INTO invites (token_hash, created_by, expires_at) VALUES (${sha256(token)}, ${admin.userID}, ${expiresAt})`;
      return json({ token, url: `${config.appOrigin}/signup?invite=${token}`, expiresAt });
    },
  };

  async function requireAdmin(req: Request) {
    const u = await requireUser(req);
    if (!u.isAdmin) throw new HttpError(403, "Admins only");
    return u;
  }

  /** Single entry point for everything under basePath. */
  const handleReq = handle(async (req: Request) => {
    const denied = checkOrigin(req, config);
    if (denied) return denied;
    const path = new URL(req.url).pathname;
    if (!path.startsWith(basePath)) return error(404, "Not found");
    const sub = path.slice(basePath.length).replace(/^\/+|\/+$/g, "");
    const route = routes[`${req.method} ${sub}`];
    if (!route) return error(404, "Not found");
    return route(req);
  });

  return { handle: handleReq, resolveUser, signupMode };
}

export type Auth = ReturnType<typeof createAuth>;
