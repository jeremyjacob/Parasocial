<script lang="ts">
	import { Plus, Crosshair, Eye, EyeOff, Code2, Copy, Trash2, MousePointer2 } from '@lucide/svelte';
	import { ContextMenu, type MenuEntry } from '$lib/components/ui/menu';
	import { toast } from '$lib/components/ui/toast';
	import { mutators } from '@parasocial/sync';
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

	const selectPart = (id: string) => ws.select([{ part: id, kind: 'part' as any, index: 0 }]);

	function menuFor(id: string, name: string): MenuEntry[] {
		const hidden = ws.hidden.includes(id);
		const isolated = ws.isolated[0] === id;
		const path = `parts/${id}.ts`;
		return [
			{ label: 'Select', icon: MousePointer2, onSelect: () => selectPart(id) },
			{ label: 'Zoom to part', icon: Crosshair, onSelect: () => (selectPart(id), ws.viewer?.fitSelection()) },
			{ type: 'separator' },
			{ label: isolated ? 'Show all parts' : 'Isolate', onSelect: () => ws.isolate(id) },
			{ label: hidden ? 'Show' : 'Hide', icon: hidden ? Eye : EyeOff, onSelect: () => ws.setHidden(id, !hidden) },
			{ type: 'separator' },
			{ label: 'Open script', icon: Code2, onSelect: () => ((ws.openScript = path), (ws.mode = 'code')) },
			{ label: 'Copy name', icon: Copy, onSelect: () => navigator.clipboard.writeText(name).then(() => toast('Copied')) },
			{ type: 'separator' },
			{
				label: 'Delete part',
				icon: Trash2,
				destructive: true,
				onSelect: () => {
					const sc = ws.scripts.find((x) => x.path === path);
					if (!sc || !confirm(`Delete “${name}”? You can restore it from History.`)) return;
					ws.mutate(mutators.script.delete({ documentID: ws.documentID, path, baseVersion: sc.version, message: `Delete ${name}` } as any), `Delete ${name}`);
				}
			}
		];
	}
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
				<ContextMenu items={menuFor(r.id, r.name)}>
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
						onclick={() => selectPart(r.id)}
					/>
				</ContextMenu>
			</li>
		{/each}
	</ul>
</div>
