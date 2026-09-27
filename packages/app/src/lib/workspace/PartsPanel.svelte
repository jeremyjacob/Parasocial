<script lang="ts">
	import { Plus } from '@lucide/svelte';
	import { ListRow } from '$lib/components/ui/list-row';
	import { IconButton } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { theme } from '$lib/theme.svelte';
	import { rise } from '$lib/styles/motion';
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
					busy: ws.regen[id] === 'running' || ws.agents.some((a) => (a.status === 'working' || a.status === 'writing') && ((a.detail as any)?.path === `parts/${id}.ts` || ws.notes.find((n) => n.id === (a.detail as any)?.noteID)?.anchor.targets.some((t) => t.part === id)))
				};
			})
			.filter((r) => !filter || r.name.toLowerCase().includes(filter.toLowerCase()) || r.id.includes(filter.toLowerCase()))
	);
	const selectedPart = $derived(new Set(ws.selection.map((s) => s.part)));
</script>

<div class="flex min-h-0 flex-1 flex-col" data-testid="parts-panel">
	<div class="border-b border-line p-2">
		<Input size="sm" placeholder="Filter parts" bind:value={filter} aria-label="Filter parts" />
	</div>
	<div class="flex h-10 items-center pt-1 pr-2 pl-4">
		<span class="text-ui font-semibold text-fg">Parts</span>
		<IconButton label="Add part" size="sm" class="ml-auto" onclick={onAddPart}><Plus /></IconButton>
	</div>
	<ul class="flex min-h-0 flex-col gap-px overflow-auto px-2 pb-2">
		{#each rows as r (r.id)}
			<li in:rise={{ y: -4 }}>
				<ListRow
					name={r.name}
					color={ws.partColor(r.id, dark)}
					status={r.status}
					statusLabel={r.label}
					busy={r.busy}
					selected={selectedPart.has(r.id)}
					visible={!ws.hidden.includes(r.id)}
					onVisibleChange={(v) => ws.setHidden(r.id, !v)}
					isolated={ws.isolated[0] === r.id}
					onIsolateChange={() => ws.isolate(r.id)}
					onclick={() => ws.select([{ part: r.id, kind: 'part' as any, index: 0 }])}
				/>
			</li>
		{/each}
	</ul>
</div>
