// Built-in agent provider settings, one row per user (user_agent_settings, server-only). The API
// key is sealed with a key derived from APP_SECRET; it goes out only to the provider.
import type { Db } from "@parasocial/sync/server";

export const PROVIDERS = ["anthropic", "openai", "google", "openai-compatible"] as const;
export type Provider = (typeof PROVIDERS)[number];

/** What the settings page shows: never the key itself. */
export type AgentSettingsView = { provider: Provider; model: string; baseURL: string | null; keyHint: string | null };
/** What a run needs. */
export type AgentCredentials = { provider: Provider; model: string; baseURL: string | null; apiKey: string | null };

export type AgentSettingsInput = {
  provider: Provider;
  model: string;
  baseURL?: string | null;
  /** undefined keeps the stored key; "" removes it */
  apiKey?: string;
};

export class SettingsError extends Error {}

export async function getAgentSettings(db: Db, userID: string): Promise<AgentSettingsView | null> {
  const [r] = await db.sql`SELECT provider, model, base_url, api_key_hint FROM user_agent_settings WHERE user_id = ${userID}`;
  return r ? { provider: r.provider, model: r.model, baseURL: r.base_url, keyHint: r.api_key_hint } : null;
}

export async function loadAgentCredentials(db: Db, secret: string, userID: string): Promise<AgentCredentials | null> {
  const [r] = await db.sql`SELECT provider, model, base_url, api_key_enc FROM user_agent_settings WHERE user_id = ${userID}`;
  if (!r) return null;
  return { provider: r.provider, model: r.model, baseURL: r.base_url, apiKey: r.api_key_enc ? await open(secret, r.api_key_enc) : null };
}

export async function saveAgentSettings(db: Db, secret: string, userID: string, input: AgentSettingsInput): Promise<AgentSettingsView> {
  const v = validate(input);
  const key = input.apiKey === undefined ? undefined : input.apiKey.trim();
  const enc = key ? await seal(secret, key) : null;
  const hint = key ? key.slice(-4) : null;
  if (key === undefined) {
    await db.sql`INSERT INTO user_agent_settings (user_id, provider, model, base_url) VALUES (${userID}, ${v.provider}, ${v.model}, ${v.baseURL})
      ON CONFLICT (user_id) DO UPDATE SET provider = EXCLUDED.provider, model = EXCLUDED.model, base_url = EXCLUDED.base_url, updated_at = now()`;
  } else {
    await db.sql`INSERT INTO user_agent_settings (user_id, provider, model, base_url, api_key_enc, api_key_hint) VALUES (${userID}, ${v.provider}, ${v.model}, ${v.baseURL}, ${enc}, ${hint})
      ON CONFLICT (user_id) DO UPDATE SET provider = EXCLUDED.provider, model = EXCLUDED.model, base_url = EXCLUDED.base_url,
        api_key_enc = EXCLUDED.api_key_enc, api_key_hint = EXCLUDED.api_key_hint, updated_at = now()`;
  }
  return (await getAgentSettings(db, userID))!;
}

export async function deleteAgentSettings(db: Db, userID: string) {
  await db.sql`DELETE FROM user_agent_settings WHERE user_id = ${userID}`;
}

function validate(input: AgentSettingsInput) {
  if (!PROVIDERS.includes(input.provider)) throw new SettingsError("Pick a provider.");
  const model = input.model.trim();
  if (!model || model.length > 200) throw new SettingsError("Enter a model id.");
  let baseURL = input.baseURL?.trim() || null;
  if (baseURL) {
    let u: URL;
    try {
      u = new URL(baseURL);
    } catch {
      throw new SettingsError("The base URL isn't a valid URL.");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new SettingsError("The base URL must be http or https.");
    baseURL = u.href.replace(/\/$/, "");
  }
  if (input.provider === "openai-compatible" && !baseURL) throw new SettingsError("OpenAI-compatible providers need a base URL (e.g. http://localhost:11434/v1 for Ollama).");
  return { provider: input.provider, model, baseURL };
}

// ── sealing ──

async function key(secret: string) {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`parasocial:agent-keys:${secret}`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(secret: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(secret), new TextEncoder().encode(plain)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return Buffer.from(out).toString("base64");
}

export async function open(secret: string, sealed: string): Promise<string> {
  const buf = Buffer.from(sealed, "base64");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.subarray(0, 12) }, await key(secret), buf.subarray(12));
  return new TextDecoder().decode(pt);
}
