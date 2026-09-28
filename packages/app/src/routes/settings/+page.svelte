<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import { KeyRound, Plus, Trash2, Bot, Copy, Link, Sparkles } from '@lucide/svelte';
	import { Button, IconButton } from '$lib/components/ui/button';
	import { SegmentedControl } from '$lib/components/ui/segmented-control';
	import { Input } from '$lib/components/ui/input';
	import { Select } from '$lib/components/ui/select';
	import { toast } from '$lib/components/ui/toast';
	import AppHeader from '$lib/components/app/app-header.svelte';
	import { addPasskey, isCancel } from '$lib/auth';
	import { relativeTime } from '$lib/format';
	import ConnectAgentDialog from '$lib/workspace/ConnectAgentDialog.svelte';

	let { data, form } = $props();
	let connectOpen = $state(false);

	// built-in agent: the provider it runs on (key stays on the server; only its last 4 come back)
	const providers = [
		{ value: 'anthropic', label: 'Anthropic' },
		{ value: 'openai', label: 'OpenAI' },
		{ value: 'google', label: 'Google' },
		{ value: 'openai-compatible', label: 'OpenAI-compatible (Ollama, OpenRouter, …)' }
	];
	const modelHint: Record<string, string> = { anthropic: 'claude-opus-5', openai: 'Model id', google: 'Model id', 'openai-compatible': 'Model id, e.g. qwen3-coder' };
	let provider = $state(data.builtinAgent?.provider ?? 'anthropic');
	let model = $state(data.builtinAgent?.model ?? '');
	let baseURL = $state(data.builtinAgent?.baseURL ?? '');
	let apiKey = $state('');
	let agentBusy = $state(false);
	const agentForm = () => {
		agentBusy = true;
		return async ({ result, update }: { result: { type: string; data?: Record<string, unknown> }; update: (o?: { reset?: boolean }) => Promise<void> }) => {
			agentBusy = false;
			await update({ reset: false });
			apiKey = '';
			if (result.type === 'success' && result.data?.agentTested) toast.success('Your provider answered');
			else if (result.type === 'success' && result.data?.agentSaved) toast.success('Agent saved');
		};
	};
	type Passkey = { id: string; name: string | null; synced: boolean; createdAt: string; lastUsedAt: string | null };
	let passkeys = $state.raw<Passkey[]>([]);
	let signupMode = $state<'open' | 'invite'>('open');
	let invites = $state.raw<{ token_hash?: string; expires_at?: string; used_at?: string | null }[]>([]);
	let inviteURL = $state('');

	async function api(path: string, body?: unknown) {
		const res = await fetch(`/api/auth/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
		const j = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(j.message ?? 'Something went wrong. Try again.');
		return j;
	}
	async function refresh() {
		passkeys = (await api('passkeys')).passkeys;
		if (data.user?.isAdmin) {
			signupMode = (await api('admin/settings')).signupMode;
			invites = (await api('admin/invites')).invites ?? [];
		}
	}
	onMount(refresh);

	async function add() {
		try {
			await addPasskey();
			toast.success('Passkey added');
			refresh();
		} catch (e) {
			if (!isCancel(e)) toast.error((e as Error).message);
		}
	}
	async function remove(id: string) {
		if (passkeys.length <= 1) return toast.error("You can't remove your only passkey");
		await api('passkeys/delete', { id });
		refresh();
	}
	async function setMode(m: string) {
		signupMode = (await api('admin/settings', { signupMode: m })).signupMode;
	}
	async function invite() {
		const r = await api('admin/invites', { ttlDays: 7 });
		inviteURL = r.url;
		await navigator.clipboard.writeText(r.url).catch(() => {});
		toast('Invite link copied');
		refresh();
	}
	const section = 'rounded-panel border border-line-subtle bg-panel';
</script>

<svelte:head><title>Settings · Parasocial</title></svelte:head>

<div class="flex min-h-dvh flex-col bg-canvas">
	<AppHeader user={data.user} title="Settings" />
	<main class="mx-auto flex w-full max-w-[640px] flex-col gap-6 px-6 py-8">
		{#if !data.agents.length && !data.builtinAgent}
			<p class="rounded-panel border border-line bg-accent-subtle px-4 py-3 text-ui" data-testid="agent-required">Parasocial needs an agent to build models. Connect a coding agent over MCP, or add an API key for the built-in agent below.</p>
		{/if}
		<section class={section} data-testid="connected-agents">
			<header class="flex h-12 items-center gap-2 border-b border-line-subtle px-4">
				<Bot size={16} class="text-fg-secondary" /><h2 class="text-section">Coding agents</h2>
				<Button size="sm" class="ml-auto" onclick={() => (connectOpen = true)} data-testid="connect-agent-button"><Plus size={14} /> Connect agent</Button>
			</header>
			<ul class="divide-y divide-line-subtle">
				{#each data.agents as a (a.id)}
					<li class="flex h-12 items-center gap-3 px-4 text-ui">
						<span class="font-medium">{a.name}</span>
						<span class="text-label text-fg-tertiary">connected {relativeTime(a.connectedAt)}</span>
						<form method="POST" action="?/revoke" use:enhance class="ml-auto"><input type="hidden" name="client" value={a.id} /><Button size="sm" variant="ghost" type="submit">Revoke</Button></form>
					</li>
				{:else}
					<li class="px-4 py-4 text-ui text-fg-secondary">None connected. Add Parasocial as an MCP server in Claude Code, Codex or OpenCode to work on your documents from the terminal.</li>
				{/each}
			</ul>
		</section>

		<section id="agent" class="{section} scroll-mt-6" data-testid="builtin-agent">
			<header class="flex h-12 items-center gap-2 border-b border-line-subtle px-4">
				<Sparkles size={16} class="text-fg-secondary" /><h2 class="text-section">Built-in agent</h2>
			</header>
			<form method="POST" action="?/saveAgent" use:enhance={agentForm} class="flex flex-col gap-3 p-4">
				<p class="text-label text-fg-secondary">Runs inside Parasocial on your own provider, billed to your key. Hand it notes from a document, or turn on agent pickup to send it every open note. The model needs tool calling and image input.</p>
				<input type="hidden" name="provider" value={provider} />
				<div class="flex items-center gap-3 text-ui">
					<span class="w-28 shrink-0 text-fg-secondary">Provider</span>
					<Select bind:value={provider} items={providers} aria-label="Provider" class="min-w-0 flex-1" />
				</div>
				<label class="flex items-center gap-3 text-ui">
					<span class="w-28 shrink-0 text-fg-secondary">Model</span>
					<Input name="model" bind:value={model} placeholder={modelHint[provider]} class="flex-1" autocomplete="off" spellcheck="false" />
				</label>
				{#if provider === 'openai-compatible' || baseURL}
					<label class="flex items-center gap-3 text-ui">
						<span class="w-28 shrink-0 text-fg-secondary">Base URL</span>
						<Input name="baseURL" bind:value={baseURL} placeholder={provider === 'openai-compatible' ? 'http://localhost:11434/v1' : 'Provider default'} class="flex-1" autocomplete="off" spellcheck="false" />
					</label>
				{/if}
				<label class="flex items-center gap-3 text-ui">
					<span class="w-28 shrink-0 text-fg-secondary">API key</span>
					<Input
						name="apiKey"
						type="password"
						bind:value={apiKey}
						placeholder={data.builtinAgent?.keyHint ? `Saved ••••${data.builtinAgent.keyHint} · type to replace` : provider === 'openai-compatible' ? 'Optional for local servers' : 'Paste your key'}
						class="flex-1"
						autocomplete="off"
					/>
				</label>
				{#if form?.agentError}<p class="text-label text-error" role="alert">{form.agentError}</p>{/if}
				<div class="flex items-center gap-2">
					<Button size="sm" type="submit" disabled={agentBusy || !model.trim()}>Save</Button>
					{#if data.builtinAgent}
						<Button size="sm" variant="ghost" type="submit" formaction="?/testAgent" disabled={agentBusy}>Test connection</Button>
						{#if data.builtinAgent.keyHint}<Button size="sm" variant="ghost" type="submit" name="clearKey" value="1" disabled={agentBusy}>Remove key</Button>{/if}
						<Button size="sm" variant="ghost" type="submit" formaction="?/removeAgent" class="ml-auto" disabled={agentBusy}>Turn off</Button>
					{/if}
				</div>
			</form>
		</section>

		<section class={section} data-testid="passkeys">
			<header class="flex h-12 items-center gap-2 border-b border-line-subtle px-4">
				<KeyRound size={16} class="text-fg-secondary" /><h2 class="text-section">Passkeys</h2>
				<Button size="sm" class="ml-auto" onclick={add}><Plus size={14} /> Add passkey</Button>
			</header>
			<ul class="divide-y divide-line-subtle">
				{#each passkeys as p (p.id)}
					<li class="flex h-12 items-center gap-3 px-4 text-ui">
						<span class="font-medium">{p.name ?? 'Passkey'}</span>
						<span class="text-label text-fg-tertiary">{p.synced ? 'Synced' : 'This device only'} · added {relativeTime(new Date(p.createdAt).getTime())}</span>
						<IconButton label="Remove passkey" size="sm" class="ml-auto" onclick={() => remove(p.id)} disabled={passkeys.length <= 1}><Trash2 /></IconButton>
					</li>
				{/each}
			</ul>
			{#if passkeys.length === 1}
				<p class="border-t border-line-subtle px-4 py-3 text-label text-warning">Add a backup passkey in case you lose this one.</p>
			{/if}
		</section>

		{#if data.user?.isAdmin}
			<section class={section} data-testid="admin">
				<header class="flex h-12 items-center gap-2 border-b border-line-subtle px-4"><h2 class="text-section">Instance</h2></header>
				<div class="flex flex-col gap-4 p-4">
					<div class="flex items-center gap-3 text-ui">
						<span class="w-28 text-fg-secondary">Sign-up</span>
						<SegmentedControl value={signupMode} items={[{ value: 'open', text: 'Open' }, { value: 'invite', text: 'Invite only' }]} onValueChange={setMode} class="w-48" />
					</div>
					{#if signupMode === 'invite'}
						<div class="flex items-center gap-3 text-ui">
							<span class="w-28 text-fg-secondary">Invites</span>
							<Button size="sm" onclick={invite}><Link size={14} /> Create invite link</Button>
						</div>
						{#if inviteURL}
							<div class="flex items-center gap-1 rounded-control bg-input pl-2.5"><code class="min-w-0 flex-1 truncate font-mono text-label">{inviteURL}</code><IconButton label="Copy" size="sm" onclick={() => navigator.clipboard.writeText(inviteURL)}><Copy /></IconButton></div>
						{/if}
					{/if}
				</div>
			</section>
		{/if}
	</main>
</div>

<ConnectAgentDialog bind:open={connectOpen} />
