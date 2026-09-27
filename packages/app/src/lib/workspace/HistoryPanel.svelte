<script lang="ts">
	import { Bot, SlidersHorizontal, RotateCcw, FileCode2, Download } from '@lucide/svelte';
	import { Avatar } from '$lib/components/ui/avatar';
	import { relativeTime } from '$lib/format';
	import type { WorkspaceState } from './state.svelte';
	let { ws, onOpen }: { ws: WorkspaceState; onOpen?: (versionID: string) => void } = $props();
	const icon = { script: FileCode2, params: SlidersHorizontal, restore: RotateCcw, import: Download } as const;
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-auto p-2" data-testid="history-panel">
	{#each ws.versions as v (v.id)}
		{@const agent = (v as any).authorAgent}
		{@const user = (v as any).authorUser}
		{@const Icon = icon[v.kind] ?? FileCode2}
		<button class="focus-ring flex w-full items-start gap-2 rounded-control px-2 py-2 text-left transition-colors-fast hover:bg-hover" onclick={() => onOpen?.(v.id)}>
			<Avatar name={agent ? `${agent.clientName}${agent.label ? ` (${agent.label})` : ''}` : (user?.name ?? 'Someone')} kind={agent ? 'agent' : 'human'} size={20} />
			<span class="min-w-0 flex-1">
				<span class="flex items-center gap-1.5 text-ui"><Icon size={12} class="shrink-0 text-fg-tertiary" /><span class="truncate">{v.message}</span></span>
				<span class="text-label text-fg-tertiary tabular-nums">v{v.number} · {relativeTime(v.createdAt)}</span>
			</span>
		</button>
	{:else}
		<div class="px-3 py-6 text-ui text-fg-secondary">No versions yet. Saving a script (<kbd class="font-mono text-label">⌘S</kbd>), an agent write or a param change creates one.</div>
	{/each}
</div>
