import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestDb, createUser, type TestDb } from "../../sync/test/helpers";
import { getAgentSettings, loadAgentCredentials, open, saveAgentSettings, seal, SettingsError } from "../src/settings";
import { toModelOutput } from "../src/tools";
import { SECRET } from "./helpers";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => db?.drop());

test("keys are sealed at rest, shown only as a hint, and kept unless replaced", async () => {
  const userID = await createUser(db);
  expect(await getAgentSettings(db, userID)).toBeNull();

  const view = await saveAgentSettings(db, SECRET, userID, { provider: "anthropic", model: " claude-opus-5 ", apiKey: "sk-ant-secret-1234" });
  expect(view).toEqual({ provider: "anthropic", model: "claude-opus-5", baseURL: null, keyHint: "1234" });
  const [row] = await db.sql`SELECT api_key_enc FROM user_agent_settings WHERE user_id = ${userID}`;
  expect(row!.api_key_enc).not.toContain("secret");

  // saving without a key keeps it; "" removes it
  await saveAgentSettings(db, SECRET, userID, { provider: "openai", model: "gpt-x" });
  expect(await loadAgentCredentials(db, SECRET, userID)).toEqual({ provider: "openai", model: "gpt-x", baseURL: null, apiKey: "sk-ant-secret-1234" });
  await saveAgentSettings(db, SECRET, userID, { provider: "openai", model: "gpt-x", apiKey: "" });
  expect((await loadAgentCredentials(db, SECRET, userID))!.apiKey).toBeNull();

  // a different APP_SECRET can't open it
  const sealed = await seal(SECRET, "k");
  expect(await open(SECRET, sealed)).toBe("k");
  await expect(open(`${SECRET}x`, sealed)).rejects.toThrow();
});

test("OpenAI-compatible providers need an http(s) base URL", async () => {
  const userID = await createUser(db);
  await expect(saveAgentSettings(db, SECRET, userID, { provider: "openai-compatible", model: "qwen3" })).rejects.toBeInstanceOf(SettingsError);
  await expect(saveAgentSettings(db, SECRET, userID, { provider: "openai-compatible", model: "qwen3", baseURL: "file:///etc" })).rejects.toBeInstanceOf(SettingsError);
  const v = await saveAgentSettings(db, SECRET, userID, { provider: "openai-compatible", model: "qwen3", baseURL: "http://localhost:11434/v1/" });
  expect(v.baseURL).toBe("http://localhost:11434/v1");
});

test("MCP results map to model content: renders go through as images, errors as error text", () => {
  expect(toModelOutput({ content: [{ type: "text", text: "ok" }, { type: "image", data: "AAAA", mimeType: "image/png" }] })).toEqual({
    type: "content",
    value: [{ type: "text", text: "ok" }, { type: "file", mediaType: "image/png", data: { type: "data", data: "AAAA" } }],
  });
  expect(toModelOutput({ isError: true, content: [{ type: "text", text: "stale baseVersion" }] })).toEqual({ type: "error-text", value: "stale baseVersion" });
});
