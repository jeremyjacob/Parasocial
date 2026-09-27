<script lang="ts">
	import { Copy, Check } from '@lucide/svelte';
	import { Dialog } from '$lib/components/ui/dialog';
	import { IconButton } from '$lib/components/ui/button';
	let { open = $bindable(false), documentID }: { open?: boolean; documentID?: string } = $props();
	const url = $derived(typeof location !== 'undefined' ? `${location.origin}/mcp${documentID ? `?document=${documentID}` : ''}` : '/mcp');
	const cmd = $derived(`claude mcp add --transport http parasocial ${url}`);
	let copied = $state('');
	async function copy(text: string, which: string) {
		await navigator.clipboard.writeText(text);
		copied = which;
		setTimeout(() => (copied = ''), 1500);
	}
</script>

<Dialog bind:open title="Connect an agent" description="Agents read your notes, edit the scripts, check their work and reply, over MCP.">
	<div class="flex flex-col gap-4" data-testid="connect-agent">
		<div class="flex flex-col gap-1.5">
			<span class="text-label text-fg-secondary">MCP server URL</span>
			<div class="flex items-center gap-1 rounded-control bg-input pl-2.5">
				<code class="min-w-0 flex-1 truncate font-mono text-label" data-testid="mcp-url">{url}</code>
				<IconButton label="Copy URL" size="sm" onclick={() => copy(url, 'url')}>{#if copied === 'url'}<Check />{:else}<Copy />{/if}</IconButton>
			</div>
		</div>
		<div class="flex flex-col gap-1.5">
			<span class="text-label text-fg-secondary">Claude Code</span>
			<div class="flex items-center gap-1 rounded-control bg-input pl-2.5">
				<code class="min-w-0 flex-1 truncate font-mono text-label">{cmd}</code>
				<IconButton label="Copy command" size="sm" onclick={() => copy(cmd, 'cmd')}>{#if copied === 'cmd'}<Check />{:else}<Copy />{/if}</IconButton>
			</div>
			<p class="text-label text-fg-tertiary">Your browser opens to sign in with your passkey and approve the connection. Connected agents are listed in Settings, where you can revoke them.</p>
		</div>
	</div>
</Dialog>
