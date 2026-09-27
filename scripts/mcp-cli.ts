// A tiny MCP client for driving Parasocial as an agent from the terminal.
//   bun scripts/mcp-cli.ts setup            human side: sign up (virtual passkey), open the bracket
//                                           example, pin a note; then OAuth-connect as an agent
//   bun scripts/mcp-cli.ts tools            list tools
//   bun scripts/mcp-cli.ts call <tool> '<json args>' [--out file.png]
//   bun scripts/mcp-cli.ts look <outfile>   screenshot the human's workspace (as the human)
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { virtualAuthenticator, signUp } from "../tests/e2e/auth";

const BASE = process.env.PS_BASE ?? "http://localhost:5173";
const STATE = join(import.meta.dir, "../.data/mcp-cli.json");
type State = { accessToken: string; refreshToken: string; clientID: string; documentID: string; noteID?: string; storage: any };

const b64url = (b: Buffer) => b.toString("base64url");

async function oauthConnect(page: import("playwright").Page, documentID: string) {
  const redirect = "http://127.0.0.1:43219/callback";
  const reg = await (await fetch(`${BASE}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Claude (mcp-cli)", redirect_uris: [redirect], token_endpoint_auth_method: "none" }) })).json();
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", resource: `${BASE}/mcp?document=${documentID}` });
  // loopback redirect, like a native client (RFC 8252)
  let code = "";
  const got = Promise.withResolvers<void>();
  const cb = Bun.serve({ port: 43219, hostname: "127.0.0.1", fetch(req) { code = new URL(req.url).searchParams.get("code") ?? ""; got.resolve(); return new Response("Connected. You can close this tab."); } });
  await page.goto(`${BASE}/oauth/authorize?${q}`);
  await page.getByTestId("approve").click();
  await got.promise;
  cb.stop();
  const tok = await (await fetch(`${BASE}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: redirect }) })).json();
  if (!tok.access_token) throw new Error(`token exchange failed: ${JSON.stringify(tok)}`);
  return { accessToken: tok.access_token, refreshToken: tok.refresh_token, clientID: reg.client_id };
}

async function setup() {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await virtualAuthenticator(page);
  await signUp(page, "Ada Lovelace", BASE);
  await page.getByTestId("example-bracket").click();
  await page.waitForURL(/\/d\//);
  const documentID = page.url().split("/d/")[1];
  await page.waitForFunction(() => (globalThis as any).__ws?.results?.bracket && (globalThis as any).__ws.kernelReady, null, { timeout: 30000 });
  await page.waitForTimeout(600);
  // pin a note on the top face, like a human reviewer would
  const vp = (await page.getByTestId("viewport").boundingBox())!;
  await page.keyboard.press("c");
  await page.mouse.click(vp.x + vp.width * 0.62, vp.y + vp.height * 0.55);
  await page.getByTestId("note-text").fill("This plate flexes too much. Make it 5 mm thick, and round the four vertical corners a bit more (4 mm).");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (globalThis as any).__ws.notes.length === 1, null, { timeout: 15000 });
  const noteID = await page.evaluate(() => (globalThis as any).__ws.notes[0].id);
  const t = await oauthConnect(page, documentID);
  const state: State = { ...t, documentID, noteID, storage: await ctx.storageState() };
  mkdirSync(join(import.meta.dir, "../.data"), { recursive: true });
  writeFileSync(STATE, JSON.stringify(state, null, 2));
  await b.close();
  console.log(JSON.stringify({ documentID, noteID, connected: true }));
}

async function client(s: State) {
  const c = new Client({ name: "mcp-cli", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp?document=${s.documentID}&label=cli`), { requestInit: { headers: { Authorization: `Bearer ${s.accessToken}` } } });
  await c.connect(transport);
  const close = c.close.bind(c);
  // end the session on the server too (DELETE), so the workspace doesn't keep a stale avatar
  c.close = async () => {
    await transport.terminateSession().catch(() => {});
    await close();
  };
  return c;
}

const cmd = process.argv[2];
if (cmd === "setup") await setup();
else {
  if (!existsSync(STATE)) throw new Error("run `setup` first");
  const s: State = JSON.parse(readFileSync(STATE, "utf8"));
  if (cmd === "tools") {
    const c = await client(s);
    const { tools } = await c.listTools();
    console.log(tools.map((t) => `${t.name}: ${t.description}`).join("\n"));
    console.log("\ninstructions:", c.getInstructions()?.slice(0, 200) + "…");
    await c.close();
  } else if (cmd === "call") {
    const c = await client(s);
    const args = JSON.parse(process.argv[4] ?? "{}");
    const outIdx = process.argv.indexOf("--out");
    const r: any = await c.callTool({ name: process.argv[3], arguments: args });
    for (const part of r.content) {
      if (part.type === "text") console.log(part.text);
      else if (part.type === "image") {
        const file = outIdx > 0 ? process.argv[outIdx + 1] : join(import.meta.dir, "../.data/render.png");
        writeFileSync(file, Buffer.from(part.data, "base64"));
        console.log(`[image saved to ${file}]`);
      }
    }
    if (r.isError) process.exitCode = 1;
    await c.close();
  } else if (cmd === "look") {
    const b = await chromium.launch();
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, storageState: s.storage });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/d/${s.documentID}`);
    await page.waitForFunction(() => (globalThis as any).__ws?.kernelReady && Object.keys((globalThis as any).__ws.results).length, null, { timeout: 30000 });
    await page.waitForTimeout(1500);
    if (process.argv[4] === "notes") await page.getByRole("tab", { name: "Notes" }).click(), await page.waitForTimeout(400);
    await page.screenshot({ path: process.argv[3] });
    console.log(await page.evaluate(() => JSON.stringify({ agents: (globalThis as any).__ws.agents.map((a: any) => [a.clientName, a.label, a.status]), notes: (globalThis as any).__ws.notes.map((n: any) => [n.status, n.orphaned]) })));
    await b.close();
  }
}
