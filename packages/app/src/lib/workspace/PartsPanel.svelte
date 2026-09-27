<script lang="ts">
	import { Focus, Plus } from '@lucide/svelte';
	import { ListRow } from '$lib/components/ui/list-row';
	import { IconButton } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { theme } from '$lib/theme.svelte';
	import type { WorkspaceState } from './state.svelte';

	let { ws, onAddPart }: { ws: WorkspaceState; onAddPart: () => void } = $props();
	let filter = $state('');
	const dark = $derived(theme.resolved === 'dark');

	const rows = $derived(
		ws.parts
			.map((id) => {
				const r = ws.results[id];
				const err = r?.problems.some((p) => p.severity === 'error');
				const warn = r?.problems.some((p) => p.severity === 'warning');
				return {
					id,
					name: r?.name ?? id,
					status: (ws.regen[id] === 'running' && !r ? 'pending' : err ? 'error' : warn ? 'warning' : 'ok') as 'ok' | 'warning' | 'error' | 'pending',
					label: err ? 'Error' : warn ? 'Warning' : 'OK',
					busy: ws.regen[id] === 'running'
				};
			})
			.filter((r) => !filter || r.name.toLowerCase().includes(filter.toLowerCase()) || r.id.includes(filter.toLowerCase()))
	);
	const selectedPart = $derived(new Set(ws.selection.map((s) => s.part)));
</script>

<div class="flex min-h-0 flex-1 flex-col" data-testid="parts-panel">
	<div class="px-2 pt-2">
		<Input size="sm" placeholder="Filter parts" bind:value={filter} aria-label="Filter parts" />
	</div>
	<div class="flex h-8 items-center px-3 text-label text-fg-secondary">
		<span class="tabular-nums">{ws.parts.length} part{ws.parts.length === 1 ? '' : 's'}</span>
		<IconButton label="Add part" size="sm" class="ml-auto" onclick={onAddPart}><Plus /></IconButton>
	</div>
	<ul class="flex min-h-0 flex-col gap-px overflow-auto px-2 pb-2">
		{#each rows as r (r.id)}
			<li>
				<ListRow
					name={r.name}
					color={ws.partColor(r.id, dark)}
					status={r.status}
					statusLabel={r.label}
					busy={r.busy}
					selected={selectedPart.has(r.id)}
					visible={!ws.hidden.includes(r.id)}
					onVisibleChange={(v) => ws.setHidden(r.id, !v)}
					onclick={() => ws.select([{ part: r.id, kind: 'part' as any, index: 0 }])}
				>
					{#snippet actions()}
						<IconButton label={ws.isolated[0] === r.id ? 'Show all' : 'Isolate'} size="sm" onclick={(e: MouseEvent) => (e.stopPropagation(), ws.isolate(r.id))}><Focus /></IconButton>
					{/snippet}
				</ListRow>
			</li>
		{/each}
	</ul>
</div>
