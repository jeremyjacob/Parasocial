<script lang="ts">
	import { Kbd } from '$lib/components/ui/kbd';
	import type { WorkspaceState } from './state.svelte';
	let { ws }: { ws: WorkspaceState } = $props();
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-auto" data-testid="notes-panel">
	{#if !ws.notes.length}
		<div class="flex flex-col gap-2 px-4 py-6 text-ui text-fg-secondary">
			<p>No notes yet. Point at geometry and say what's wrong; agents pick notes up over MCP.</p>
			<p class="flex items-center gap-1.5 text-label">Press <Kbd keys={['C']} /> and click a face, or <Kbd keys={['P']} /> to sketch over the model.</p>
		</div>
	{/if}
</div>
