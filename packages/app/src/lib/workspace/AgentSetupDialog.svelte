<script lang="ts">
	import { untrack } from 'svelte';
	import { Bot, Sparkles } from '@lucide/svelte';
	import { deserialize } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { Dialog } from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Select } from '$lib/components/ui/select';
	import { providers, defaultModel, modelHint } from '$lib/agent-providers';

	// Opened over "New studio" when there's no agent to build with: add a key for the built-in
	// agent right here (saved through Settings' action), or go connect a coding agent instead.
	let { open = $bindable(false), onSaved, onConnect }: { open?: boolean; onSaved: () => void; onConnect: () => void } = $props();

	let provider = $state('anthropic');
	let model = $state(defaultModel.anthropic);
	let baseURL = $state('');
	let apiKey = $state('');
	let busy = $state(false);
	let error = $state('');
	const local = $derived(provider === 'openai-compatible');
	const ready = $derived(!busy && !!model.trim() && (local ? !!baseURL.trim() : !!apiKey.trim()));

	// switching provider swaps in its default model, unless the user typed their own
	$effect(() => {
		const next = defaultModel[provider] ?? '';
		untrack(() => {
			if (!model.trim() || Object.values(defaultModel).includes(model)) model = next;
		});
	});
	$effect(() => {
		if (open) untrack(() => ((error = ''), (apiKey = '')));
	});

	async function save(e: Event) {
		e.preventDefault();
		if (!ready) return;
		busy = true;
		error = '';
		const body = new FormData();
		body.set('provider', provider);
		body.set('model', model.trim());
		if (baseURL.trim()) body.set('baseURL', baseURL.trim());
		body.set('apiKey', apiKey);
		try {
			const res = await fetch('/settings?/saveAgent', { method: 'POST', body, headers: { accept: 'application/json' } });
			const result = deserialize(await res.text());
			if (result.type === 'success') {
				await invalidateAll();
				open = false;
				onSaved();
			} else if (result.type === 'failure') error = String(result.data?.agentError ?? "Couldn't save. Try again.");
			else error = "Couldn't save. Try again.";
		} catch {
			error = "Couldn't save. Check your connection and try again.";
		} finally {
			busy = false;
		}
	}
</script>

<Dialog bind:open title="Set up an agent" description="Parasocial needs an agent to build the part. Add an API key for the built-in agent, billed to your provider." class="w-[min(480px,calc(100vw-32px))]">
	<form id="agent-setup" onsubmit={save} class="flex flex-col gap-3" data-testid="agent-setup-dialog">
		<div class="flex items-center gap-3 text-ui">
			<span class="w-20 shrink-0 text-fg-secondary">Provider</span>
			<Select bind:value={provider} items={providers} aria-label="Provider" class="min-w-0 flex-1" />
		</div>
		<label class="flex items-center gap-3 text-ui">
			<span class="w-20 shrink-0 text-fg-secondary">Model</span>
			<Input bind:value={model} placeholder={modelHint[provider]} class="flex-1" autocomplete="off" spellcheck="false" />
		</label>
		{#if local}
			<label class="flex items-center gap-3 text-ui">
				<span class="w-20 shrink-0 text-fg-secondary">Base URL</span>
				<Input bind:value={baseURL} placeholder="http://localhost:11434/v1" class="flex-1" autocomplete="off" spellcheck="false" />
			</label>
		{/if}
		<label class="flex items-center gap-3 text-ui">
			<span class="w-20 shrink-0 text-fg-secondary">API key</span>
			<Input type="password" bind:value={apiKey} placeholder={local ? 'Optional for local servers' : 'Paste your key'} class="flex-1" autocomplete="off" data-testid="agent-setup-key" />
		</label>
		{#if error}<p class="text-label text-error" role="alert">{error}</p>{/if}
		<div class="mt-1 flex items-center gap-3 border-t border-line-subtle pt-3">
			<p class="flex-1 text-label text-fg-secondary">Use Claude Code, Codex or OpenCode instead?</p>
			<Button size="sm" variant="ghost" onclick={() => ((open = false), onConnect())}><Bot size={14} /> Connect a coding agent</Button>
		</div>
	</form>
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (open = false)} disabled={busy}>Cancel</Button>
		<Button variant="primary" type="submit" form="agent-setup" disabled={!ready} loading={busy} data-testid="agent-setup-save">{#if !busy}<Sparkles size={14} />{/if} Save and build</Button>
	{/snippet}
</Dialog>
