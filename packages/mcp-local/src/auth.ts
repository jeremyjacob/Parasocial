// OAuth for the local bridge: a public client with a loopback redirect (RFC 8252), like any
// native MCP client. Client registration and tokens persist per origin in ~/.parasocial so
// Claude Code can respawn the bridge without another sign-in.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { log } from "./log";

const FILE = join(process.env.PARASOCIAL_HOME ?? join(homedir(), ".parasocial"), "auth.json");
const CALLBACK_PATH = "/callback";
const SIGN_IN_TIMEOUT = 5 * 60_000;

type Saved = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens };

function readAll(): Record<string, Saved> {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

function write(origin: string, patch: Partial<Saved>) {
  const all = readAll();
  all[origin] = { ...all[origin], ...patch };
  mkdirSync(join(FILE, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
}

export function forget(origin: string) {
  const all = readAll();
  delete all[origin];
  mkdirSync(join(FILE, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
}

function openBrowser(url: string) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {}
}

type Callback = { port: number; code: Promise<string>; close: () => void };

/** Listen on a free loopback port for the authorization redirect. */
function listen(): Promise<Callback> {
  const got = Promise.withResolvers<string>();
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname !== CALLBACK_PATH) return res.writeHead(404).end();
    const code = u.searchParams.get("code");
    const error = u.searchParams.get("error");
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end(code ? "Signed in to Parasocial. You can close this tab." : `Sign-in failed: ${error ?? "no code"}`);
    if (code) got.resolve(code);
    else got.reject(new Error(`Sign-in failed: ${error ?? "no code"}`));
  });
  const timer = setTimeout(() => got.reject(new Error("Timed out waiting for sign-in")), SIGN_IN_TIMEOUT);
  got.promise.catch(() => {});
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, code: got.promise, close: () => (clearTimeout(timer), server.close()) });
    });
  });
}

const LOCK = `${FILE}.lock`;

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  mkdirSync(join(FILE, ".."), { recursive: true, mode: 0o700 });
  for (const until = Date.now() + 15_000; ; ) {
    try {
      mkdirSync(LOCK);
      break;
    } catch {
      try {
        if (Date.now() - statSync(LOCK).mtimeMs > 30_000) rmSync(LOCK, { recursive: true, force: true });
      } catch {}
      if (Date.now() > until) break; // a crashed holder; go ahead unlocked
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(LOCK, { recursive: true, force: true });
  }
}

/**
 * fetch for the MCP transport that serializes refreshes across bridge processes sharing
 * ~/.parasocial. The server no longer rotates refresh tokens, but if one ever changes, a refresh
 * whose token another process already replaced gets that process's tokens.
 */
export function refreshSafeFetch(origin: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body instanceof URLSearchParams ? init.body : typeof init?.body === "string" ? new URLSearchParams(init.body) : null;
    if (init?.method !== "POST" || body?.get("grant_type") !== "refresh_token") return fetch(input, init);
    return withLock(async () => {
      const current = readAll()[origin]?.tokens;
      if (current?.refresh_token && current.refresh_token !== body.get("refresh_token")) return new Response(JSON.stringify(current), { headers: { "Content-Type": "application/json" } });
      const res = await fetch(input, init);
      if (res.ok) write(origin, { tokens: await res.clone().json() });
      return res;
    });
  }) as typeof fetch;
}

export class LocalAuth implements OAuthClientProvider {
  private verifier = "";
  private callback: Callback | null = null;
  constructor(private origin: string) {}

  // Registered without a port; loopback redirects match on any port (RFC 8252 §7.3), and the
  // port is only known once a sign-in starts listening.
  get redirectUrl() {
    return `http://127.0.0.1${this.callback ? `:${this.callback.port}` : ""}${CALLBACK_PATH}`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "Claude Code", redirect_uris: [this.redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }

  clientInformation() {
    return readAll()[this.origin]?.client;
  }
  saveClientInformation(client: OAuthClientInformationMixed) {
    write(this.origin, { client });
  }
  tokens() {
    return readAll()[this.origin]?.tokens;
  }
  saveTokens(tokens: OAuthTokens) {
    write(this.origin, { tokens });
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all") forget(this.origin);
    else if (scope === "client") write(this.origin, { client: undefined, tokens: undefined });
    else if (scope === "tokens") write(this.origin, { tokens: undefined });
    else if (scope === "verifier") this.verifier = "";
  }

  async redirectToAuthorization(url: URL) {
    this.callback?.close();
    this.callback = await listen();
    url.searchParams.set("redirect_uri", this.redirectUrl);
    log(`Sign in to Parasocial in your browser: ${url}`);
    openBrowser(url.toString());
  }

  /** The code from the redirect started by redirectToAuthorization. */
  waitForCode() {
    if (!this.callback) throw new Error("No sign-in in progress");
    return this.callback.code;
  }

  /** After the code exchange (which needs the same redirect URL). */
  endSignIn() {
    this.callback?.close();
    this.callback = null;
  }
}
