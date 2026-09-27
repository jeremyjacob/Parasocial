<script lang="ts">
	import { FileCode2, Folder } from '@lucide/svelte';
	import type { WorkspaceState } from './state.svelte';
	let { ws, dirty = new Set<string>() }: { ws: WorkspaceState; dirty?: Set<string> } = $props();
	const groups = $derived([
		{ dir: 'parts', items: ws.scripts.filter((s) => s.path.startsWith('parts/')) },
		{ dir: 'lib', items: ws.scripts.filter((s) => s.path.startsWith('lib/')) }
	]);
	function open(path: string) {
		ws.openScript = path;
		ws.revealLine = null;
		ws.mode = 'code';
	}
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-auto p-2" data-testid="scripts-panel">
	{#each groups as g (g.dir)}
		<div class="flex h-8 items-center gap-1.5 px-2 text-label text-fg-secondary"><Folder size={14} /> {g.dir}/</div>
		{#each g.items as s (s.id)}
			{@const err = ws.results[s.path.slice(6, -3)]?.problems.some((p) => p.severity === 'error')}
			<button
				class="focus-ring flex h-8 w-full shrink-0 items-center gap-1.5 rounded-control pr-2 pl-7 text-left text-ui transition-colors-fast hover:bg-hover {ws.openScript === s.path && ws.mode === 'code' ? 'bg-active' : ''}"
				onclick={() => open(s.path)}
			>
				<FileCode2 size={14} class="text-fg-tertiary" />
				<span class="truncate">{s.path.slice(g.dir.length + 1)}</span>
				{#if dirty.has(s.path)}<span class="size-1.5 rounded-full bg-fg-secondary" aria-label="Unsaved changes"></span>{/if}
				<span class="ml-auto flex items-center gap-1.5">
					{#if err}<span class="size-1.5 rounded-full bg-error" aria-label="Error"></span>{/if}
					<span class="text-label text-fg-tertiary tabular-nums">v{s.version}</span>
				</span>
			</button>
		{:else}
			<p class="flex h-8 items-center pl-7 text-label text-fg-tertiary">No scripts</p>
		{/each}
	{/each}
</div>
