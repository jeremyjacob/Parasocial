<script lang="ts">
	import { Bot, KeyRound, ArrowRight } from '@lucide/svelte';
	import { cn } from '$lib/utils';

	/** Shown until the user has an agent: their own provider key (built-in agent) or a coding agent over MCP. Flat tiles; the page supplies the heading. */
	let { onConnect, class: className }: { onConnect: () => void; class?: string } = $props();
	const tile =
		'group flex items-start gap-3 rounded-panel border border-line bg-panel p-4 text-left transition-colors hover:border-line-strong focus-visible:outline-none focus-ring';
	const chip = 'grid size-8 shrink-0 place-items-center rounded-control bg-accent-subtle text-accent-fg';
	const arrow = 'mt-0.5 shrink-0 text-fg-tertiary transition-transform group-hover:translate-x-0.5 group-hover:text-fg';
</script>

<div class={cn('grid gap-3 sm:grid-cols-2', className)} data-testid="agent-setup">
	<a class={tile} href="/settings#agent" data-testid="setup-api-key">
		<span class={chip}><KeyRound size={16} /></span>
		<span class="flex min-w-0 flex-1 flex-col gap-1">
			<span class="text-ui font-medium">Use your API key</span>
			<span class="text-label text-fg-secondary">Run the built-in agent on Anthropic, OpenAI, Google or a local model.</span>
		</span>
		<ArrowRight size={16} class={arrow} />
	</a>
	<button type="button" class={tile} onclick={onConnect} data-testid="setup-connect-agent">
		<span class={chip}><Bot size={16} /></span>
		<span class="flex min-w-0 flex-1 flex-col gap-1">
			<span class="text-ui font-medium">Connect a coding agent</span>
			<span class="text-label text-fg-secondary">Add Parasocial over MCP in Claude Code, Codex or OpenCode.</span>
		</span>
		<ArrowRight size={16} class={arrow} />
	</button>
</div>
