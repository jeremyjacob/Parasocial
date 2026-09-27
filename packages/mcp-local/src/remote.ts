// The Parasocial MCP session this bridge speaks for. One remote session per bridge, so the
// agent has one identity (avatar, claims, note cursor) whether Claude calls a tool or the
// channel pump waits for notes. The server forgets sessions on restart or after 30 idle
// minutes; calls then reconnect once and retry (the server hands the same agent back).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { LocalAuth, refreshSafeFetch } from "./auth";
import { log } from "./log";

export const VERSION = "1.0.0";

async function connect(url: URL, auth: LocalAuth) {
  const attempt = async () => {
    const client = new Client({ name: "parasocial-mcp-local", version: VERSION });
    const transport = new StreamableHTTPClientTransport(url, { authProvider: auth, fetch: refreshSafeFetch(url.origin) });
    try {
      await client.connect(transport);
      return { client, transport };
    } catch (e) {
      if (e instanceof UnauthorizedError) return { transport };
      throw e;
    }
  };
  const first = await attempt();
  if (first.client) return first;
  // redirectToAuthorization opened the browser; finish on the loopback redirect
  try {
    await first.transport.finishAuth(await auth.waitForCode());
  } finally {
    auth.endSignIn();
  }
  const second = await attempt();
  if (!second.client) throw new Error("Signed in, but the server still refused the connection. Run `parasocial-mcp login` and try again.");
  log("signed in");
  return second;
}

export class Remote {
  client!: Client;
  private transport!: StreamableHTTPClientTransport;
  private reconnecting: Promise<void> | null = null;
  private auth: LocalAuth;

  constructor(readonly url: URL) {
    this.auth = new LocalAuth(url.origin);
  }

  async connect() {
    ({ client: this.client, transport: this.transport } = await connect(this.url, this.auth));
  }

  /** Run a request, reconnecting once if the server lost the session. */
  async call<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const c = this.client;
    try {
      return await fn(c);
    } catch (e) {
      if (!(e instanceof StreamableHTTPError && e.code === 404)) throw e;
      if (this.client === c) {
        this.reconnecting ??= (async () => {
          log("session expired on the server; reconnecting");
          await c.close().catch(() => {});
          await this.connect();
        })().finally(() => (this.reconnecting = null));
      }
      await this.reconnecting;
      return fn(this.client);
    }
  }

  /** End the server session too, so the workspace drops the avatar and claims are released. */
  async close() {
    await this.transport?.terminateSession().catch(() => {});
    await this.client?.close().catch(() => {});
  }
}
