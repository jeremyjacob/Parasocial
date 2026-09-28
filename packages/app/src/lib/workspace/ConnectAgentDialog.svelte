<script lang="ts">
	import { Copy, Check, KeyRound } from '@lucide/svelte';
	import { page } from '$app/state';
	import { Dialog } from '$lib/components/ui/dialog';
	import { Button, IconButton } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { SegmentedControl } from '$lib/components/ui/segmented-control';
	import { toast } from '$lib/components/ui/toast';
	let { open = $bindable(false), documentID, documentName }: { open?: boolean; documentID?: string; documentName?: string } = $props();
	let useDefault = $state(false);
	const origin = $derived(typeof location !== 'undefined' ? location.origin : '');
	const url = $derived(`${origin}/mcp${useDefault && documentID ? `?document=${encodeURIComponent(documentID)}` : ''}`);
	let agent = $state('claude');
	// Claude Code channel (research preview): a local stdio bridge (packages/mcp-local) that
	// forwards to the same server and pushes new notes into the session
	let liveNotes = $state(false);
	const bridge = '~/.parasocial/parasocial-mcp.js';
	const runtime = '$(command -v bun || command -v node)';
	const agents = $derived([
		liveNotes
			? {
					value: 'claude', text: 'Claude Code',
					command: `mkdir -p ~/.parasocial && curl -fsSL '${origin}/parasocial-mcp.js' -o ${bridge} && claude mcp add parasocial -- ${runtime} ${bridge} --url '${url}' --channel`,
					setup: 'Run this in your terminal to install the Parasocial bridge (Node or Bun) and add it. Run it again to update.',
					auth: 'Then sign in through your browser, and start Claude Code with the channel loaded (it asks you to confirm).',
					login: `${runtime} ${bridge} login --url '${url}'`,
					start: 'claude --dangerously-load-development-channels server:parasocial'
				}
			: {
					value: 'claude', text: 'Claude Code',
					command: `claude mcp add --transport http parasocial '${url}'`,
					setup: 'Run this in your terminal to add Parasocial.',
					auth: 'Then open Claude Code, run /mcp and select Parasocial to sign in.'
				},
		{
			value: 'codex', text: 'Codex',
			command: `codex mcp add parasocial --url '${url}'`,
			setup: 'Run this in your terminal to add Parasocial.',
			auth: 'Then run the command below and finish signing in through your browser.',
			login: 'codex mcp login parasocial'
		},
		{
			value: 'opencode', text: 'OpenCode',
			command: 'opencode mcp add',
			setup: 'Run this in your terminal. Name the server parasocial, choose Remote and paste the MCP server URL above.',
			auth: 'Then run the command below and finish signing in through your browser.',
			login: 'opencode mcp auth parasocial'
		}
	]);
	const selected: { command: string; setup: string; auth: string; login?: string; start?: string } = $derived(agents.find((item) => item.value === agent)!);
	const prompt = $derived(`Work on ${JSON.stringify(documentName ?? 'this document')} in Parasocial. Open ${origin}/d/${documentID} (document ID: ${documentID}) with open_document, then use it for this task.`);
	let contentHeight = $state<number>();
	let copied = $state('');
	async function copy(text: string, which: string) {
		try {
			await navigator.clipboard.writeText(text);
			copied = which;
			setTimeout(() => (copied = ''), 1500);
		} catch {
			toast.error('Could not copy to the clipboard. Select and copy the text instead.');
		}
	}
</script>

<Dialog bind:open title="Connect an agent" class="max-h-[calc(100dvh-32px)] overflow-y-auto">
	<div class="animated-height" style:height={contentHeight === undefined ? undefined : `${contentHeight}px`}>
		<div class="flex flex-col gap-4" data-testid="connect-agent" bind:clientHeight={contentHeight}>
			<p class="text-ui text-fg-secondary">Connect once to work across your documents or create new designs. Your agent gets recent browser activity to help find the right document.</p>
			{#if documentID}
				<div class="flex justify-between items-center gap-1.5 py-1.5">
					<span class="text-ui font-medium">Already connected?</span>
					<!-- <p class="text-label text-fg-secondary">Give your agent this document and describe what you want to do.</p> -->
					<!-- <p class="break-words text-label text-fg-secondary" data-testid="agent-prompt">{prompt}</p> -->
					<Button size="sm" class="self-start" onclick={() => copy(prompt, 'prompt')} data-testid="copy-agent-prompt">{#if copied === 'prompt'}<Check size={14} /> Copied{:else}<Copy size={14} /> Copy agent prompt{/if}</Button>
				</div>
				<!-- <Checkbox bind:checked={useDefault} label="Use this document by default" />
				{#if useDefault}<p class="text-label text-fg-secondary">Useful for a repository connection. Sets a starting document; your agent can still access your other documents.</p>{/if} -->
			{/if}
			<div class="flex flex-col gap-1.5">
				<span class="text-label text-fg-secondary">MCP server URL</span>
				<div class="flex items-center gap-1 rounded-control bg-input pl-2.5">
					<code class="min-w-0 flex-1 truncate font-mono text-label" data-testid="mcp-url">{url}</code>
					<IconButton label="Copy URL" size="sm" onclick={() => copy(url, 'url')}>{#if copied === 'url'}<Check />{:else}<Copy />{/if}</IconButton>
				</div>
			</div>
			<div class="flex flex-col gap-2.5">
				<SegmentedControl bind:value={agent} items={agents} fill aria-label="Agent" onValueChange={() => (copied = '')} />
				{#if agent === 'claude'}
					<Checkbox bind:checked={liveNotes} label="Tell Claude about new notes as they arrive" onCheckedChange={() => (copied = '')} />
					{#if liveNotes}<p class="text-label text-fg-secondary">Uses Claude Code channels, a research preview. Claude picks up notes without being asked.</p>{/if}
				{/if}
				<p class="text-label text-fg-secondary">{selected.setup}</p>
				<div class="flex items-center gap-1 rounded-control bg-input pl-2.5">
					<code class="min-w-0 flex-1 break-all py-2 font-mono text-label" data-testid="agent-command">{selected.command}</code>
					<IconButton label="Copy command" size="sm" onclick={() => copy(selected.command, 'cmd')}>{#if copied === 'cmd'}<Check />{:else}<Copy />{/if}</IconButton>
				</div>
				<p class="text-label text-fg-secondary">{selected.auth}</p>
				{#if selected.login}
					<div class="flex items-center gap-1 rounded-control bg-input pl-2.5">
						<code class="min-w-0 flex-1 break-all py-2 font-mono text-label" data-testid="agent-login">{selected.login}</code>
						<IconButton label="Copy sign-in command" size="sm" onclick={() => copy(selected.login!, 'login')}>{#if copied === 'login'}<Check />{:else}<Copy />{/if}</IconButton>
					</div>
				{/if}
				{#if selected.start}
					<div class="flex items-center gap-1 rounded-control bg-input pl-2.5">
						<code class="min-w-0 flex-1 break-all py-2 font-mono text-label" data-testid="agent-start">{selected.start}</code>
						<IconButton label="Copy start command" size="sm" onclick={() => copy(selected.start!, 'start')}>{#if copied === 'start'}<Check />{:else}<Copy />{/if}</IconButton>
					</div>
				{/if}
			</div>
			{#if !page.data.agentConfigured}
				<div class="flex items-center gap-3 border-t border-line-subtle pt-4" data-testid="connect-agent-builtin">
					<p class="flex-1 text-label text-fg-secondary">No coding agent? Use the built-in agent with your own API key instead.</p>
					<Button size="sm" variant="ghost" href="/settings#agent"><KeyRound size={14} /> Add API key</Button>
				</div>
			{/if}
		</div>
	</div>
</Dialog>

<style>
	.animated-height {
		overflow: clip;
		overflow-clip-margin: 4px;
		transition: height var(--duration-base) var(--ease-out);
	}
</style>
