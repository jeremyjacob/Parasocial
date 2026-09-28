// Providers the built-in agent runs on (Settings and the in-document setup dialog share these)
export const providers = [
	{ value: 'anthropic', label: 'Anthropic' },
	{ value: 'openai', label: 'OpenAI' },
	{ value: 'google', label: 'Google' },
	{ value: 'openai-compatible', label: 'OpenAI-compatible (Ollama, OpenRouter, …)' }
];
export const defaultModel: Record<string, string> = { anthropic: 'claude-opus-5-5', openai: 'gpt-6-astra' };
export const modelHint: Record<string, string> = { ...defaultModel, google: 'Model id', 'openai-compatible': 'Model id, e.g. qwen3-coder' };
export const providerLabel = (v: string) => providers.find((p) => p.value === v)?.label.replace(/ \(.*\)$/, '') ?? v;
