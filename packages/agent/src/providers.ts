// Provider-agnostic model construction (AI SDK). Keys always come from the user's settings, never
// from the server's environment: the providers' env fallbacks would spend the instance's key.
import { generateText, type LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { AgentCredentials } from "./settings";

export class ProviderSetupError extends Error {}

export function languageModel(c: AgentCredentials): LanguageModel {
  const baseURL = c.baseURL ?? undefined;
  if (c.provider === "openai-compatible") {
    if (!baseURL) throw new ProviderSetupError("Add a base URL for your OpenAI-compatible provider in Settings.");
    // local servers (Ollama, LM Studio) usually take no key
    return createOpenAICompatible({ name: "custom", baseURL, apiKey: c.apiKey ?? undefined }).chatModel(c.model);
  }
  if (!c.apiKey) throw new ProviderSetupError("Add an API key for your agent's provider in Settings.");
  const apiKey = c.apiKey;
  switch (c.provider) {
    case "anthropic":
      return createAnthropic({ apiKey, baseURL })(c.model);
    case "openai":
      return createOpenAI({ apiKey, baseURL })(c.model);
    case "google":
      return createGoogle({ apiKey, baseURL })(c.model);
  }
}

/** One tiny request, so a wrong key, model or URL shows up in Settings rather than on a note. Returns an error message, or null. */
export async function testProvider(c: AgentCredentials): Promise<string | null> {
  try {
    await generateText({ model: languageModel(c), prompt: "Reply with OK.", maxOutputTokens: 16, maxRetries: 0, timeout: 30_000 });
    return null;
  } catch (e) {
    if (e instanceof ProviderSetupError) return e.message;
    return `The provider said: ${(e as Error).message}`.slice(0, 400);
  }
}
