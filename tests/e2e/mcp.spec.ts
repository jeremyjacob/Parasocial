import { test, expect, openExample, viewportPoint, wsEval } from "./fixtures";
import type { Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash, randomBytes } from "node:crypto";
import sharp from "sharp";

// The agent loop over MCP (§7): a human pins a note; an agent (OAuth'd as that human) lists
// notes, claims one, edits the script and replies; the workspace shows it live.

const BASE = "http://localhost:5173";
const CLIENT_NAME = "E2E Agent";

/**
 * OAuth 2.1 as a native MCP client would do it: dynamic client registration, authorization code
 * with PKCE through the consent page (approved by the signed-in human), then the token exchange.
 * The code is read off the loopback redirect in the browser instead of running a callback server.
 */
async function connectAgent(page: Page, documentID?: string) {
  const endpoint = `${BASE}/mcp${documentID ? `?document=${documentID}` : ""}`;
  const redirect = "http://127.0.0.1:43219/callback";
  const reg = await page.request.post("/oauth/register", { data: { client_name: CLIENT_NAME, redirect_uris: [redirect], token_endpoint_auth_method: "none" } });
  expect(reg.status()).toBe(201);
  const { client_id } = await reg.json();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(8).toString("hex");
  const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state, resource: endpoint });

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
  const transportURL = new URL(endpoint);
  transportURL.searchParams.set("label", "e2e");
  const transport = new StreamableHTTPClientTransport(transportURL, { requestInit: { headers: { Authorization: `Bearer ${access_token}` } } });
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

test("MCP renders optional section cuts and rejects invalid planes", async ({ page, user }) => {
  void user;
  test.setTimeout(180_000);
  const documentID = await openExample(page, "bracket", ["bracket"]);
  const agent = await connectAgent(page, documentID);
  try {
    const { tools } = await agent.client.listTools();
    expect(tools.find((t) => t.name === "render")?.inputSchema.properties).toHaveProperty("section");
    let renderIndex = 0;
    const render = async (section?: { origin: number[]; normal: number[] }) => {
      const result = await agent.client.callTool({ name: "render", arguments: { parts: ["bracket"], view: "top", width: 256, height: 256, ...(section ? { section } : {}) } });
      expect(result.isError).not.toBe(true);
      const img = (result.content as { type: string; data: string; mimeType: string }[]).find((c) => c.type === "image")!;
      expect(img.mimeType).toBe("image/png");
      await test.info().attach(`render-${renderIndex++}`, { body: Buffer.from(img.data, "base64"), contentType: "image/png" });
      const { data, info } = await sharp(Buffer.from(img.data, "base64")).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      expect([info.width, info.height]).toEqual([256, 256]);
      // Inspect the central plate area, away from the grid and triad.
      let dark = 0;
      for (let y = 96; y < 160; y++) for (let x = 96; x < 160; x++) {
        const i = (y * info.width + x) * info.channels;
        if (data[i] + data[i + 1] + data[i + 2] < 600) dark++;
      }
      return { data, dark };
    };
    const full = await render();
    const cut = await render({ origin: [0, 0, 1.5], normal: [0, 0, 2] });
    expect(cut.data.equals(full.data)).toBe(false);
    expect(cut.dark).toBeGreaterThan(100);
    const removed = await render({ origin: [0, 0, 10], normal: [0, 0, -1] });
    expect(removed.dark).toBeLessThan(cut.dark / 4);
    // A section is local to one image, including on a reused engine-pool page.
    const restored = await render();
    // Ambient-occlusion sampling can vary slightly between fresh viewers.
    const meanDifference = restored.data.reduce((sum, value, i) => sum + Math.abs(value - full.data[i]), 0) / full.data.length;
    expect(meanDifference).toBeLessThan(2);
    for (const section of [
      { origin: [0, 0, 0], normal: [0, 0, 0] },
      { origin: [0, 0], normal: [0, 0, 1] },
      { origin: [0, 0, 0], normal: [0, 1] },
      { origin: [0, 0, 0], normal: [0, 0, 1e-300] },
      { origin: [0, 0, 0], normal: [0, 0, 1e300] },
    ]) {
      const result = await agent.client.callTool({ name: "render", arguments: { section } });
      expect(result.isError).toBe(true);
    }
  } finally {
    await agent.close();
  }
});

test("general connection, document handoff and browser context", async ({ page, user }) => {
  void user;
  await page.getByTestId("connect-agent-button").click();
  await expect(page.getByTestId("mcp-url")).toHaveText(`${BASE}/mcp`);
  await expect(page.getByTestId("copy-agent-prompt")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByTestId("new-document").click();
  await page.getByTestId("new-document-name").fill("Browser context document");
  await page.getByTestId("create-document").click();
  await page.waitForURL(/\/d\//);
  const documentID = page.url().split("/d/")[1]!;
  await page.getByTestId("connect-agent-button").click();
  await expect(page.getByTestId("mcp-url")).toHaveText(`${BASE}/mcp`);
  await expect(page.getByTestId("agent-prompt")).toContainText(`http://localhost:5173/d/${documentID}`);
  await expect(page.getByTestId("agent-prompt")).toContainText('"Browser context document"');
  await page.getByRole("checkbox", { name: "Use this document by default" }).click();
  await expect(page.getByTestId("mcp-url")).toHaveText(`${BASE}/mcp?document=${documentID}`);
  await page.keyboard.press("Escape");

  const agent = await connectAgent(page);
  try {
    expect(agent.client.getInstructions()).toContain(documentID);
    expect(agent.client.getInstructions()).toContain("Browser context document");
    expect(agent.client.getInstructions()).toContain("Session default document: null");
    const context = await agent.call("get_document_context");
    expect(context.default).toBeUndefined();
    expect(context.recentBrowserDocuments).toEqual(expect.arrayContaining([expect.objectContaining({ id: documentID, recentlyActive: true })]));
    await agent.call("open_document", { document: `${BASE}/d/${documentID}` });
    await agent.call("rename_document", { name: "Renamed by agent" });
    const copy = await agent.call("duplicate_document");
    expect(copy.name).toBe("Renamed by agent (copy)");
    await agent.call("delete_document", { document: copy.id });
    const docs = await agent.call("list_documents");
    expect(docs.documents.map((d: { id: string }) => d.id)).toEqual([documentID]);
    expect(docs.default).toBe(documentID);
  } finally {
    await agent.close();
  }
  await page.goto("/settings");
  await page.getByTestId("connect-agent-button").click();
  await expect(page.getByTestId("mcp-url")).toHaveText(`${BASE}/mcp`);
});

test("agent loop: human note → agent claims, edits, replies → Resolved in the UI", async ({ page, user }) => {
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
    const sc = await agent.call<{ version: number; content: string }>("read_script", { path: "studios/bracket.ts" });
    expect(sc.content).toContain('param("thickness", 3,');
    const res = await agent.call<any>("edit_script", {
      path: "studios/bracket.ts",
      baseVersion: sc.version,
      message: "Thicker plate, larger corner fillets",
      note: noteID,
      edits: [
        { search: 'param("thickness", 3,', replace: 'param("thickness", 5,' },
        { search: '2, { tag: "corners" }', replace: '4, { tag: "corners" }' },
      ],
    });
    expect(res.version).toBeTruthy();
    expect(res.parts).toEqual({ bracket: "ok" });

    // completed work can be resolved silently, without adding a thread message
    // The edit's activity entry must reach the browser before taking the baseline.
    await expect.poll(() => wsEval<boolean>(page, "ws.notes[0].messages.some(m => m.kind === 'activity')")).toBe(true);
    const messagesBefore = await wsEval<number>(page, "ws.notes[0].messages.length");
    await agent.call("set_note_status", { id: noteID, status: "Resolved" });
    await expect.poll(() => wsEval(page, "({ status: ws.notes[0].status, claimedBy: ws.notes[0].claimedBy })")).toEqual({ status: "Resolved", claimedBy: null });
    expect(await wsEval<number>(page, "ws.notes[0].messages.length")).toBe(messagesBefore);

    // an optional useful reply still links the version and resolves by default
    await agent.call("claim_note", { id: noteID });
    const reply = "Made the plate 5 mm thick and the corner fillets 4 mm.";
    const r = await agent.call<any>("reply_to_note", { id: noteID, text: reply });
    expect(r).toMatchObject({ ok: true, status: "Resolved" });
    expect(r.linkedVersion).toBe(res.version.id);

    // the human sees it all in the workspace
    await expect.poll(() => wsEval(page, "({ status: ws.notes[0].status, claimedBy: ws.notes[0].claimedBy })")).toEqual({ status: "Resolved", claimedBy: null });
    await expect(card).toHaveCount(0); // completed notes leave the default open queue
    await page.getByLabel("Filter by status", { exact: true }).click();
    await page.getByRole("option", { name: "Resolved", exact: true }).click();
    await expect(card).toContainText("Resolved");
    await expect(card.getByRole("button", { name: "Reopen", exact: true })).toBeVisible();
    await expect(card).toContainText(reply);
    await expect(card).toContainText(CLIENT_NAME);
    await expect(card).toContainText("Thicker plate, larger corner fillets"); // linked version summary
    // the geometry changed: the plate is 5 mm thick now
    await expect.poll(() => wsEval<number>(page, "ws.results.bracket.bbox.max[2] - ws.results.bracket.bbox.min[2]"), { timeout: 30_000 }).toBeCloseTo(5, 1);
    await expect.poll(() => page.evaluate(() => (globalThis as any).__ws.scripts.find((s: any) => s.path === "studios/bracket.ts")?.content as string)).toContain('4, { tag: "corners" }');
    expect(await wsEval<number>(page, "ws.versions.length")).toBe(versionsBefore + 1);
    // the version is the agent's, and the note stays attached to its (moved) top face
    await page.getByRole("tab", { name: "History" }).click();
    await expect(page.getByTestId("history-panel").getByTestId("version-row").first()).toContainText("Thicker plate, larger corner fillets");
    // waiting for more work: the human's follow-up wakes wait_for_notes (the note from before the
    // agent connected isn't news, and neither is the agent's own reply)
    expect(await agent.call<any>("wait_for_notes", { timeoutSeconds: 1 })).toMatchObject({ notes: [] });
    const waiting = agent.call<any>("wait_for_notes", { timeoutSeconds: 30 });
    const t0 = Date.now();
    await page.waitForTimeout(300);
    await page.evaluate(() => (globalThis as any).__nc.reply((globalThis as any).__ws.notes[0].id, "Looks good, but make the fillets 3 mm."));
    const woke = await waiting;
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(woke.notes).toHaveLength(1);
    expect(woke.notes[0]).toMatchObject({ id: noteID, reason: { replies: [{ text: "Looks good, but make the fillets 3 mm." }] } });
    expect(woke.notes[0].reason.created).toBeUndefined();
    await expect.poll(() => wsEval<string>(page, "ws.notes[0].status")).toBe("Open"); // a human reply reopens it

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

    // callers can still ask for review, leave questions open, or explicitly resolve
    for (const status of ["AwaitingReview", "Open", "Resolved"]) {
      await agent.call("claim_note", { id: noteID });
      expect(await agent.call("reply_to_note", { id: noteID, text: `Reply with ${status}`, status })).toMatchObject({ ok: true, status });
      await expect.poll(() => wsEval(page, "({ status: ws.notes[0].status, claimedBy: ws.notes[0].claimedBy })")).toEqual({ status, claimedBy: null });
    }
  } finally {
    await agent.close();
  }
});
