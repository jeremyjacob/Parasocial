<script lang="ts">
	import { Bot, KeyRound, ArrowRight } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { cn } from '$lib/utils';

	/** Shown until the user has an agent: their own provider key (built-in agent) or a coding agent over MCP. */
	let { onConnect, class: className }: { onConnect: () => void; class?: string } = $props();
	const option = 'flex flex-col gap-2 rounded-control border border-line-subtle bg-canvas p-4 text-left';
</script>

<section class={cn('rounded-panel border border-line bg-panel p-5 text-left', className)} data-testid="agent-setup">
	<h2 class="text-section">Set up an agent to start designing</h2>
	<p class="mt-1 text-ui text-fg-secondary">Agents write and edit the models in Parasocial. Pick one way in; you can add the other later.</p>
	<div class="mt-4 grid gap-3 sm:grid-cols-2">
		<div class={option}>
			<span class="flex items-center gap-2 text-ui font-medium"><KeyRound size={14} class="text-fg-secondary" /> Use your API key</span>
			<p class="flex-1 text-label text-fg-secondary">Run the built-in agent on Anthropic, OpenAI, Google or a local model. Hand it notes right from the document.</p>
			<Button variant="primary" size="sm" class="self-start" href="/settings#agent" data-testid="setup-api-key">Add API key <ArrowRight size={14} /></Button>
		</div>
		<div class={option}>
			<span class="flex items-center gap-2 text-ui font-medium"><Bot size={14} class="text-fg-secondary" /> Connect a coding agent</span>
			<p class="flex-1 text-label text-fg-secondary">Add Parasocial as an MCP server in Claude Code, Codex or OpenCode and work from your terminal.</p>
			<Button size="sm" class="self-start" onclick={onConnect} data-testid="setup-connect-agent">Connect agent <ArrowRight size={14} /></Button>
		</div>
	</div>
</section>
