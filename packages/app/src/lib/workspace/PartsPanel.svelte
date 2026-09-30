<script lang="ts">
	import { Plus, Code2, Copy, Trash2, ChevronRight, Download, Box, Boxes, MessageCircle } from '@lucide/svelte';
	import { sourcePart } from '@parasocial/runtime/protocol';
	import { ContextMenu, type MenuEntry } from '$lib/components/ui/menu';
	import { toast } from '$lib/components/ui/toast';
	import { mutators } from '@parasocial/sync';
	import { ListRow } from '$lib/components/ui/list-row';
	import { IconButton } from '$lib/components/ui/button';
	import { ConfirmDialog } from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { theme } from '$lib/theme.svelte';
	import { rise } from '$lib/styles/motion';
	import { cn } from '$lib/utils';
	import type { WorkspaceState } from './state.svelte';

	let { ws, onAddStudio, onExport, onAddNote, onAddStudioNote }: { ws: WorkspaceState; onAddStudio: () => void; onExport: (parts: string[]) => void; onAddNote: (parts: string[]) => void; onAddStudioNote: (file: string) => void } = $props();
	let filter = $state('');
	/** Expanded studios (by path); studios start collapsed. */
	let expanded = $state<Set<string>>(new Set());
	const dark = $derived(theme.resolved === 'dark');

	type Status = 'ok' | 'warning' | 'error' | 'pending';
	const RANK: Record<Status, number> = { ok: 0, pending: 1, warning: 2, error: 3 };
	const LABEL: Record<Status, string> = { ok: 'OK', pending: 'Pending', warning: 'Warning', error: 'Error' };

	const agentBusy = (file: string, id: string, sourceFile = file) =>
		ws.agents.some((a) => (a.status === 'working' || a.status === 'writing') && ([file, sourceFile].includes((a.detail as any)?.path) || ws.notes.find((n) => n.id === (a.detail as any)?.noteID)?.anchor.targets.some((t) => t.kind === 'studio' ? t.studio === file : t.part === id)));

	const partName = (id: string) => ws.results[id]?.name ?? ws.partInfos.find((p) => p.id === sourcePart(id))?.name ?? id;

	// Each studio with what it shows in the viewport: its parts, or an assembly's instances (joints are in Properties).
	const tree = $derived.by(() => {
		const q = filter.trim().toLowerCase();
		// assemblies first, otherwise in document order
		const studios = [...ws.partTree].sort((a, b) => Number(b.assemblies.length > 0) - Number(a.assemblies.length > 0));
		return studios.flatMap(({ file, name, assemblies, ids }) => {
			const asmError = ws.asm.problems.some((p) => assemblies.some((a) => a.id === p.assembly));
			const rows = ids.map((id) => {
				// an instance shows its source part's state
				const src = sourcePart(id);
				const r = ws.results[id];
				const err = r?.problems.some((p) => p.severity === 'error');
				const warn = r?.problems.some((p) => p.severity === 'warning');
				const status: Status = ws.regen[src] === 'running' && !r ? 'pending' : err ? 'error' : warn ? 'warning' : 'ok';
				return { id, name: r?.name ?? partName(id), status, busy: ws.regen[src] === 'running' || agentBusy(file, id, ws.scriptOf(src)) };
			});
			// a studio's name matching shows all its parts; otherwise only the matching parts
			const all = !q || name.toLowerCase().includes(q);
			const shown = all ? rows : rows.filter((r) => r.name.toLowerCase().includes(q) || r.id.includes(q));
			if (!all && !shown.length) return [];
			const status = rows.reduce<Status>((s, r) => (RANK[r.status] > RANK[s] ? r.status : s), asmError ? 'error' : 'ok');
			return [{ file, name, asm: assemblies.length > 0, rows: shown, ids, status, busy: rows.some((r) => r.busy) }];
		});
	});
	const selectedPart = $derived(new Set(ws.selection.map((s) => s.part)));
	/** The studio in the viewport; the others are greyed. */
	const active = $derived(ws.studio?.file ?? null);

	/** Clicking a studio shows it (like switching tabs); clicking a part also shows its studio. */
	const showStudio = (file: string) => {
		if (active !== file) ws.setActiveStudio(file);
	};
	/** Clicking a studio's row selects the studio itself: its properties (and joints) show. */
	const selectStudio = (file: string) => (showStudio(file), ws.clearSelection());
	const partRefs = (ids: string[]) => ids.map((part) => ({ part, kind: 'part' as any, index: 0 }));
	const selectParts = (file: string, ids: string[], e?: MouseEvent) => ((anchor = ids.at(-1) ?? null), showStudio(file), ws.select(partRefs(ids), e ? ws.selectionMode(e) : 'replace'));
	/** Right-click selects like a click first, unless the part is already selected as a whole. */
	const ctxSelect = (file: string, id: string) => ws.selection.some((s) => s.part === id && (s.kind as string) === 'part') || selectParts(file, [id]);

	/** Where shift-click ranges start: the last part clicked without shift. */
	let anchor: string | null = null;
	/**
	 * Shift-click selects the shown rows between the anchor and the clicked part, within its studio (the others aren't in the viewport).
	 * Shift alone replaces the selection with the range; with ⌘/Ctrl (or additive selection) it's added. The anchor stays put.
	 */
	function clickPart(file: string, id: string, e: MouseEvent) {
		if (!e.shiftKey) return selectParts(file, [id], e);
		const rows = tree.find((g) => g.file === file)?.rows.map((r) => r.id) ?? [];
		// a stale anchor (deselected elsewhere, another studio, filtered out) falls back to the studio's last selected part
		const from = [anchor, ...ws.selection.map((s) => s.part).reverse()].find((p) => p && selectedPart.has(p) && rows.includes(p));
		if (!from) return selectParts(file, [id]);
		const [a, b] = [rows.indexOf(from), rows.indexOf(id)].sort((x, y) => x - y);
		anchor = from;
		showStudio(file);
		ws.select(partRefs(rows.slice(a, b + 1)), ws.additiveSelection || e.metaKey || e.ctrlKey ? 'add' : 'replace');
	}
	const openScript = (path: string) => ((ws.openScript = path), (ws.revealLine = null), (ws.mode = 'code'));

	function toggleExpanded(file: string) {
		const next = new Set(expanded);
		if (!next.delete(file)) next.add(file);
		expanded = next;
	}

	let deleteOpen = $state(false);
	let deleteTarget = $state({ path: '', label: '' });
	function deleteStudio(path: string, label: string) {
		if (!ws.scripts.some((x) => x.path === path)) return;
		deleteTarget = { path, label };
		deleteOpen = true;
	}
	function confirmDeleteStudio() {
		const { path, label } = deleteTarget;
		const sc = ws.scripts.find((x) => x.path === path);
		if (!sc) return;
		ws.mutate(mutators.script.delete({ documentID: ws.documentID, path, baseVersion: sc.version, message: `Delete ${label}` } as any), `Delete ${label}`);
	}

	function menuFor(id: string, name: string, file: string, siblings: number): MenuEntry[] {
		// an instance is removed by editing its assembly, not by deleting a studio
		const instance = sourcePart(id) !== id;
		if (ws.readOnly)
			return [
				{ label: 'Export…', icon: Download, onSelect: () => onExport([...selectedPart]) },
				{ label: 'Copy name', icon: Copy, onSelect: () => navigator.clipboard.writeText(name).then(() => toast('Copied')) },
				{ label: 'Open code', icon: Code2, onSelect: () => openScript(ws.scriptOf(sourcePart(id))) }
			];
		return [
			{ label: 'Add note', icon: MessageCircle, onSelect: () => onAddNote([id]) },
			{ label: 'Export…', icon: Download, onSelect: () => onExport([...selectedPart]) },
			{ label: 'Copy name', icon: Copy, onSelect: () => navigator.clipboard.writeText(name).then(() => toast('Copied')) },
			...(instance ? ([{ label: 'Open part code', icon: Code2, onSelect: () => openScript(ws.scriptOf(sourcePart(id))) }] as MenuEntry[]) : []),
			// a part that shares its studio with others is removed by editing the studio
			...(siblings === 1 && !instance ? ([{ type: 'separator' }, { label: 'Delete part', icon: Trash2, destructive: true, onSelect: () => deleteStudio(file, name) }] as MenuEntry[]) : [])
		];
	}

	function studioMenu(file: string, name: string, ids: string[]): MenuEntry[] {
		if (ws.readOnly)
			return [
				{ label: 'Open code', icon: Code2, onSelect: () => openScript(file) },
				{ label: 'Export…', icon: Download, onSelect: () => onExport(ids) }
			];
		return [
			{ label: 'Add note', icon: MessageCircle, onSelect: () => onAddStudioNote(file) },
			{ label: 'Open code', icon: Code2, onSelect: () => openScript(file) },
			{ label: 'Export…', icon: Download, onSelect: () => onExport(ids) },
			{ type: 'separator' },
			{ label: 'Delete studio', icon: Trash2, destructive: true, onSelect: () => deleteStudio(file, name) }
		];
	}

</script>

<ConfirmDialog
	bind:open={deleteOpen}
	title={`Delete “${deleteTarget.label}”?`}
	description="You can restore it from History."
	onconfirm={confirmDeleteStudio}
/>

<div class="flex min-h-0 flex-1 flex-col" data-testid="parts-panel">
	<div class="border-b border-line p-2">
		<Input size="sm" placeholder="Filter studios and parts" bind:value={filter} aria-label="Filter studios and parts" />
	</div>
	<div class="flex h-10 items-center pt-1 pr-2 pl-4">
		<h2 class="text-section text-fg">Studios</h2>
		{#if !ws.readOnly}<IconButton label="Add studio" size="sm" class="ml-auto" onclick={onAddStudio}><Plus /></IconButton>{/if}
	</div>
	<ul class="scrollbar-slim flex min-h-0 flex-col gap-px overflow-auto px-2 pb-2" role="tree" aria-label="Parts by studio">
		{#each tree as g (g.file)}
			{@const open = expanded.has(g.file) || !!filter.trim()}
			<li in:rise={{ y: -4 }} role="treeitem" aria-expanded={open} aria-selected={false} aria-current={active === g.file ? 'true' : undefined} data-studio={g.file}>
				<ContextMenu items={studioMenu(g.file, g.name, g.ids)} onOpen={() => showStudio(g.file)}>
					<!-- Figma-style: the chevron hangs in the row's left padding, the type icon takes the leading cell -->
					<ListRow
						name={g.name}
						class="pl-6 text-fg-secondary"
						status={g.status}
						statusLabel={LABEL[g.status]}
						busy={g.busy && !open}
						strong={active === g.file}
						dimmed={active !== g.file}
						hideable={false}
						onclick={() => selectStudio(g.file)}
					>
						{#snippet leading()}
							<button
								type="button"
								class="focus-ring absolute top-1/2 left-0.5 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-fg-tertiary hover:text-fg"
								aria-label="{open ? 'Collapse' : 'Expand'} {g.name}"
								onpointerdown={(e) => e.stopPropagation()}
								onclick={(e) => (e.stopPropagation(), toggleExpanded(g.file))}
							>
								<ChevronRight size={14} class={cn(open && 'rotate-90')} />
							</button>
							{@const Icon = g.asm ? Boxes : Box}
							<span class="inline-flex text-fg-tertiary" title={g.asm ? 'Assembly' : 'Part studio'}><Icon size={14} /></span>
						{/snippet}
					</ListRow>
				</ContextMenu>
				{#if open}
					<ul class="flex flex-col gap-px pt-px" role="group">
						{#each g.rows as r (r.id)}
							<li role="treeitem" aria-selected={selectedPart.has(r.id)}>
								<ContextMenu items={menuFor(r.id, r.name, g.file, g.ids.length)} onOpen={() => ctxSelect(g.file, r.id)}>
									<ListRow
										name={r.name}
										class="pl-10"
										color={ws.partColor(r.id, dark)}
										status={r.status}
										statusLabel={LABEL[r.status]}
										busy={r.busy}
										selected={selectedPart.has(r.id)}
										dimmed={active !== g.file}
										visible={!ws.hidden.includes(r.id)}
										onVisibleChange={(v) => ws.setHidden(r.id, !v)}
										onclick={(e) => clickPart(g.file, r.id, e)}
									/>
								</ContextMenu>
							</li>
						{/each}
					</ul>
				{/if}
			</li>
		{/each}
	</ul>
</div>
