<script lang="ts">
	import { Bot, SlidersHorizontal, RotateCcw, FileCode2, Download } from '@lucide/svelte';
	import { Avatar } from '$lib/components/ui/avatar';
	import { relativeTime } from '$lib/format';
	import { rise } from '$lib/styles/motion';
	import type { WorkspaceState } from './state.svelte';
	let { ws, onOpen, onCompare, viewing = null }: { ws: WorkspaceState; onOpen?: (versionID: string) => void; onCompare?: (versionID: string) => void; viewing?: string | null } = $props();
	const icon = { script: FileCode2, params: SlidersHorizontal, restore: RotateCcw, import: Download } as const;
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-auto p-2" data-testid="history-panel">
	{#each ws.versions as v (v.id)}
		{@const agent = (v as any).authorAgent}
		{@const user = (v as any).authorUser}
		{@const Icon = icon[v.kind] ?? FileCode2}
		<div class="group relative" in:rise={{ y: -4 }}>
		<button class="focus-ring flex w-full items-start gap-2 rounded-control px-2 py-2 text-left transition-colors-fast hover:bg-hover {viewing === v.id ? 'bg-active' : ''}" onclick={() => onOpen?.(v.id)} data-testid="version-row">
			<Avatar name={agent ? `${agent.clientName}${agent.label ? ` (${agent.label})` : ''}` : (user?.name ?? 'Someone')} kind={agent ? 'agent' : 'human'} size={20} />
			<span class="min-w-0 flex-1">
				<span class="flex items-center gap-1.5 text-ui group-hover:pr-16 group-has-[:focus-visible]:pr-16"><Icon size={12} class="shrink-0 text-fg-tertiary" /><span class="truncate">{v.message}</span></span>
				<span class="text-label text-fg-tertiary tabular-nums">v{v.number} · {relativeTime(v.createdAt)}</span>
			</span>
		</button>
		<button class="focus-ring pointer-events-none absolute top-2 right-2 rounded-xs px-1.5 text-label text-accent opacity-0 transition-opacity duration-[var(--duration-fast)] group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 hover:underline" onclick={() => onCompare?.(v.id)}>Compare</button>
		</div>
	{:else}
		<div class="px-3 py-6 text-ui text-fg-secondary">No versions yet.</div>
	{/each}
</div>
