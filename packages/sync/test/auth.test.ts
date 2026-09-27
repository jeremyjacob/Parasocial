import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createAuth, SESSION_COOKIE } from "../src/server/auth.ts";
import { createTestDb, type TestDb } from "./helpers.ts";
import { SoftAuthenticator } from "./soft-authenticator.ts";

const ORIGIN = "https://cad.example.test";
const ENGINE = "https://engine.cad.example.test";
const config = {
  rpID: "cad.example.test",
  rpName: "Parasocial",
  appOrigin: ORIGIN,
  engineOrigins: [ENGINE],
  sessionTTLms: 86400_000,
  secureCookies: true,
};

let db: TestDb;
let auth: ReturnType<typeof createAuth>;
beforeAll(async () => {
  db = await createTestDb();
  auth = createAuth({ db, config });
});
afterAll(() => db.drop());

/** A browser: a cookie jar plus a passkey authenticator. */
class Browser {
  jar = new Map<string, string>();
  authenticator = new SoftAuthenticator(ORIGIN);
  constructor(readonly origin = ORIGIN) {}

  async call(method: string, path: string, body?: unknown) {
    const headers = new Headers({ origin: this.origin, "content-type": "application/json" });
    if (this.jar.size) headers.set("cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await auth.handle(new Request(`${ORIGIN}/api/auth/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
    for (const c of res.headers.getSetCookie()) {
      const [kv, ...attrs] = c.split(";").map((s) => s.trim());
      const [k, v] = kv!.split("=");
      if (attrs.some((a) => a === "Max-Age=0")) this.jar.delete(k!);
      else this.jar.set(k!, v!);
    }
    return { status: res.status, body: (await res.json()) as any, res };
  }

  async signUp(name: string, invite?: string) {
    const opts = await this.call("POST", "register/options", { name, invite });
    if (opts.status !== 200) return opts;
    const response = await this.authenticator.create(opts.body);
    return this.call("POST", "register/verify", { response });
  }

  async signIn() {
    const opts = await this.call("POST", "login/options");
    const response = await this.authenticator.get(opts.body);
    return this.call("POST", "login/verify", { response });
  }
}

describe("passkeys", () => {
  let ada: Browser;

  test("first account becomes admin; session cookie is HttpOnly", async () => {
    ada = new Browser();
    const before = await ada.call("GET", "session");
    expect(before.body).toMatchObject({ user: null, needsSetup: true, signupMode: "open" });
    const r = await ada.signUp("Ada");
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ name: "Ada", isAdmin: true });
    const setCookie = r.res.headers.getSetCookie().find((c) => c.startsWith(SESSION_COOKIE))!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    const s = await ada.call("GET", "session");
    expect(s.body.user).toMatchObject({ name: "Ada", isAdmin: true });
    expect(s.body.needsSetup).toBe(false);
    // only the hash of the token is stored
    const [row] = await db.sql`SELECT id FROM auth_sessions`;
    expect(row!.id).not.toBe(ada.jar.get(SESSION_COOKIE));
  });

  test("sign out, then sign in with a discoverable credential (no username)", async () => {
    await ada.call("POST", "logout");
    expect((await ada.call("GET", "session")).body.user).toBeNull();
    const opts = await ada.call("POST", "login/options");
    expect(opts.body.allowCredentials).toEqual([]); // autofill / discoverable
    const r = await ada.signIn();
    expect(r.status).toBe(200);
    expect(r.body.user.name).toBe("Ada");
    const [pk] = await db.sql`SELECT counter, last_used_at FROM passkeys`;
    expect(Number(pk!.counter)).toBe(1);
    expect(pk!.last_used_at).not.toBeNull();
  });

  test("second account is not admin; add and remove passkeys", async () => {
    const bob = new Browser();
    const r = await bob.signUp("Bob");
    expect(r.body.user).toMatchObject({ name: "Bob", isAdmin: false });

    const opts = await bob.call("POST", "passkeys/options");
    expect(opts.body.excludeCredentials).toHaveLength(1);
    const phone = new SoftAuthenticator(ORIGIN); // a second device
    const response = await phone.create(opts.body);
    const added = await bob.call("POST", "passkeys/verify", { response, name: "Phone" });
    expect(added.status).toBe(200);
    const list = (await bob.call("GET", "passkeys")).body.passkeys;
    expect(list.map((p: any) => p.name)).toEqual(["Passkey", "Phone"]);
    expect(list[0].synced).toBe(true);

    // sign in with the new device
    const fresh = new Browser();
    fresh.authenticator = phone;
    expect((await fresh.signIn()).body.user.name).toBe("Bob");

    // remove one; the last one can't be removed
    expect((await bob.call("POST", "passkeys/delete", { id: list[1].id })).status).toBe(200);
    const last = await bob.call("POST", "passkeys/delete", { id: list[0].id });
    expect(last.status).toBe(400);
  });

  test("replayed or mismatched ceremonies fail", async () => {
    const eve = new Browser();
    const opts = await eve.call("POST", "register/options", { name: "Eve" });
    const response = await eve.authenticator.create(opts.body);
    // wrong origin in clientData
    const evil = new SoftAuthenticator("https://evil.example");
    const opts2 = await eve.call("POST", "register/options", { name: "Eve" });
    const bad = await eve.call("POST", "register/verify", { response: await evil.create(opts2.body) });
    expect(bad.status).toBe(400);
    // the challenge was single-use: replaying the first response fails too
    const replay = await eve.call("POST", "register/verify", { response });
    expect(replay.status).toBe(400);
    // unknown credential at sign-in
    const stranger = new Browser();
    const lo = await stranger.call("POST", "login/options");
    const s = new SoftAuthenticator(ORIGIN);
    await s.create({ rp: { id: config.rpID }, user: { id: "eA" }, challenge: "x" });
    const res = await stranger.call("POST", "login/verify", { response: await s.get(lo.body) });
    expect(res.status).toBe(400);
  });

  test("invite-only sign-up", async () => {
    const nonAdmin = new Browser();
    await nonAdmin.signUp("Nobody");
    expect((await nonAdmin.call("POST", "admin/settings", { signupMode: "invite" })).status).toBe(403);

    expect((await ada.call("POST", "admin/settings", { signupMode: "invite" })).body.signupMode).toBe("invite");
    const blocked = await new Browser().signUp("Mallory");
    expect(blocked.status).toBe(403);

    const inv = await ada.call("POST", "admin/invites", {});
    expect(inv.body.url).toStartWith(`${ORIGIN}/signup?invite=`);
    const carol = new Browser();
    expect((await carol.signUp("Carol", "wrong-token")).status).toBe(403);
    const ok = await carol.signUp("Carol", inv.body.token);
    expect(ok.status).toBe(200);
    // single use
    expect((await new Browser().signUp("Dave", inv.body.token)).status).toBe(403);
    const invites = (await ada.call("GET", "admin/invites")).body.invites;
    expect(invites[0].redeemed_by).toBe("Carol");
    await ada.call("POST", "admin/settings", { signupMode: "open" });
  });
});

describe("origin checks", () => {
  test("requests from the engine origin are rejected, even GETs", async () => {
    const engine = new Browser(ENGINE);
    expect((await engine.call("GET", "session")).status).toBe(403);
    expect((await engine.call("POST", "login/options")).status).toBe(403);
  });

  test("cross-origin state-changing requests are rejected", async () => {
    const other = new Browser("https://elsewhere.example");
    expect((await other.call("POST", "register/options", { name: "x" })).status).toBe(403);
  });

  test("resolveUser ignores bogus and expired sessions", async () => {
    const req = (token: string) => new Request(`${ORIGIN}/x`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    expect(await auth.resolveUser(req("nope"))).toBeNull();
    const b = new Browser();
    await b.signUp("Temp");
    const token = b.jar.get(SESSION_COOKIE)!;
    expect((await auth.resolveUser(req(token)))?.name).toBe("Temp");
    await db.sql`UPDATE auth_sessions SET expires_at = now() - interval '1 minute'`;
    expect(await auth.resolveUser(req(token))).toBeNull();
  });
});
