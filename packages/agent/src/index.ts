// The built-in agent (server-only): works notes handed to it on the user's own model provider.
export { createAgentDispatcher, type AgentDispatcher } from "./dispatcher";
export { runNote, builtinSession, BUILTIN_CLIENT_NAME, MAX_STEPS, type RunOutcome, type RunOptions } from "./run";
export { languageModel, testProvider, ProviderSetupError } from "./providers";
export { mcpToolSet, toModelOutput, EXCLUDED_TOOLS } from "./tools";
export {
  PROVIDERS,
  getAgentSettings,
  loadAgentCredentials,
  saveAgentSettings,
  deleteAgentSettings,
  SettingsError,
  type Provider,
  type AgentSettingsView,
  type AgentSettingsInput,
  type AgentCredentials,
} from "./settings";
