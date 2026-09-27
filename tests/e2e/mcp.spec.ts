import { test, expect, openExample, viewportPoint, wsEval } from "./fixtures";
import type { Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash, randomBytes } from "node:crypto";

// The agent loop over MCP (§7): a human pins a note; an agent (OAuth'd as that human) lists
// notes, claims one, edits the script and replies; the workspace shows it live.

const BASE = "http://localhost:5173";
const CLIENT_NAME = "E2E Agent";

/**
 * OAuth 2.1 as a native MCP client would do it: dynamic client registration, authorization code
 * with PKCE through the consent page (approved by the signed-in human), then the token exchange.
 * The code is read off the loopback redirect in the browser instead of running a callback server.
 */
async function connectAgent(page: Page, documentID: string) {
  const redirect = "http://127.0.0.1:43219/callback";
  const reg = await page.request.post("/oauth/register", { data: { client_name: CLIENT_NAME, redirect_uris: [redirect], token_endpoint_auth_method: "none" } });
  expect(reg.status()).toBe(201);
  const { client_id } = await reg.json();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(8).toString("hex");
  const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state, resource: `${BASE}/mcp?document=${documentID}` });

  const back = page.url();
  await page.goto(`/oauth/authorize?${q}`);
  await expect(page.getByTestId("consent")).toContainText(`Allow ${CLIENT_NAME} to work on your documents?`);
  // nothing listens on the loopback port: read the code off the redirect request itself
  const [req] = await Promise.all([page.waitForRequest((r) => r.url().startsWith(redirect)), page.getByTestId("approve").click()]);
  const callback = new URL(req.url());
  expect(callback.searchParams.get("code")).toBeTruthy();
  expect(callback.searchParams.get("state")).toBe(state);

  const tok = await page.request.post("/oauth/token", {
    form: { grant_type: "authorization_code", code: callback.searchParams.get("code")!, code_verifier: verifier, client_id, redirect_uri: redirect },
  });
  expect(tok.ok()).toBe(true);
  const { access_token } = await tok.json();
  expect(access_token).toBeTruthy();

  const client = new Client({ name: "e2e", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp?document=${documentID}&label=e2e`), { requestInit: { headers: { Authorization: `Bearer ${access_token}` } } });
  await client.connect(transport);
  await page.goto(back);
  return {
    client,
    async call<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
      const r: any = await client.callTool({ name, arguments: args });
      const txt = r.content.find((c: any) => c.type === "text")?.text ?? "";
      if (r.isError) throw new Error(`${name} failed: ${txt}`);
      try {
        return JSON.parse(txt);
      } catch {
        return txt as T;
      }
    },
    async close() {
      await transport.terminateSession().catch(() => {});
      await client.close();
    },
  };
}

test("agent loop: human note → agent claims, edits, replies → Awaiting review in the UI", async ({ page, user }) => {
  void user;
  test.setTimeout(180_000); // sign-up, OAuth round trip and several regenerations
  const documentID = await openExample(page, "bracket", ["bracket"]);

  // /mcp needs a token
  expect((await page.request.post("/mcp", { data: {} })).status()).toBe(401);

  // the human pins a note on the top face
  await page.keyboard.press("c");
  const p = await viewportPoint(page, 0.62, 0.55);
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
  const ask = "This plate flexes too much. Make it 5 mm thick, and round the four vertical corners more (4 mm).";
  await page.getByTestId("note-text").fill(ask);
  await page.keyboard.press("Enter");
  await expect.poll(() => wsEval<number>(page, "ws.notes.length")).toBe(1);
  const noteID = await wsEval<string>(page, "ws.notes[0].id");
  const versionsBefore = await wsEval<number>(page, "ws.versions.length");

  const agent = await connectAgent(page, documentID);
  try {
    // back in the workspace, the agent shows up as a live avatar
    await page.waitForFunction(() => (globalThis as any).__ws?.kernelReady && (globalThis as any).__ws.results?.bracket, null, { timeout: 45_000 });
    await expect(page.getByTestId("agent-presence")).toBeVisible();
    await expect.poll(() => wsEval<string[]>(page, "ws.agents.filter(a => a.status !== 'disconnected').map(a => a.clientName)")).toContain(CLIENT_NAME);

    const { tools } = await agent.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["list_notes", "claim_note", "read_script", "edit_script", "reply_to_note"]));

    // list the open notes: the human's note with its target described by stable name
    const { notes } = await agent.call<{ notes: any[] }>("list_notes", { status: "Open" });
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe(noteID);
    expect(JSON.stringify(notes[0])).toContain("bracket/base · cap.end");
    expect(JSON.stringify(notes[0])).toContain("flexes too much");

    // claim it: the workspace shows the agent working on it
    await agent.call("claim_note", { id: noteID });
    await expect.poll(() => wsEval<string>(page, "ws.notes[0].status")).toBe("AgentWorking");
    await page.getByRole("tab", { name: "Notes" }).click();
    const card = page.getByTestId("notes-panel").getByTestId("note-card");
    await expect(card).toContainText("Agent working");

    // edit the script: thickness 3 → 5, corner fillet 2 → 4
    const sc = await agent.call<{ version: number; content: string }>("read_script", { path: "parts/bracket.ts" });
    expect(sc.content).toContain('param("thickness", 3,');
    const res = await agent.call<any>("edit_script", {
      path: "parts/bracket.ts",
      baseVersion: sc.version,
      message: "Thicker plate, larger corner fillets",
      note: noteID,
      edits: [
        { search: 'param("thickness", 3,', replace: 'param("thickness", 5,' },
        { search: '2, { tag: "corners" }', replace: '4, { tag: "corners" }' },
      ],
    });
    expect(res.version).toBeTruthy();
    expect(JSON.stringify(res.regeneration)).not.toMatch(/"ok":\s*false/);

    // reply: links the version and moves the note to Awaiting review
    const reply = "Made the plate 5 mm thick and the corner fillets 4 mm.";
    const r = await agent.call<any>("reply_to_note", { id: noteID, text: reply });
    expect(r).toMatchObject({ ok: true, status: "AwaitingReview" });
    expect(r.linkedVersion).toBe(res.version.id);

    // the human sees it all in the workspace
    await expect.poll(() => wsEval<string>(page, "ws.notes[0].status")).toBe("AwaitingReview");
    await expect(card).toContainText("Awaiting review");
    await expect(card).toContainText(reply);
    await expect(card).toContainText(CLIENT_NAME);
    await expect(card).toContainText("Thicker plate, larger corner fillets"); // linked version summary
    // the geometry changed: the plate is 5 mm thick now
    await expect.poll(() => wsEval<number>(page, "ws.results.bracket.bbox.max[2] - ws.results.bracket.bbox.min[2]"), { timeout: 30_000 }).toBeCloseTo(5, 1);
    await expect.poll(() => page.evaluate(() => (globalThis as any).__ws.scripts.find((s: any) => s.path === "parts/bracket.ts")?.content as string)).toContain('4, { tag: "corners" }');
    expect(await wsEval<number>(page, "ws.versions.length")).toBe(versionsBefore + 1);
    // the version is the agent's, and the note stays attached to its (moved) top face
    await page.getByRole("tab", { name: "History" }).click();
    await expect(page.getByTestId("history-panel").getByTestId("version-row").first()).toContainText("Thicker plate, larger corner fillets");
    await expect.poll(() => page.evaluate(() => (globalThis as any).__nc.pins[0]?.resolution)).toBe("name");
    expect(await page.evaluate(() => (globalThis as any).__nc.pins[0].point[2])).toBeCloseTo(5, 0);
    // the pin is drawn on the moved face (reported with its visibility state if it isn't)
    await expect
      .poll(() =>
        page.evaluate(() => {
          const ws = (globalThis as any).__ws, p = (globalThis as any).__nc.pins[0];
          const at = ws.viewer.camera.position.clone().set(...p.point);
          return { pins: document.querySelectorAll('[data-testid="pin"]').length, visible: ws.viewer.isPointVisible(at), screen: ws.viewer.project(at) };
        }),
      { timeout: 30_000 })
      .toMatchObject({ pins: 1 });
  } finally {
    await agent.close();
  }
});
