<script lang="ts">
	import { Plus, Code2, Copy, Trash2, ChevronRight, Download, RotateCw, MoveHorizontal, Cylinder, Move, Orbit, Link2 } from '@lucide/svelte';
	import type { AssemblyJoint } from '@parasocial/runtime/protocol';
	import { num } from '$lib/format';
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

	let { ws, onAddStudio, onExport }: { ws: WorkspaceState; onAddStudio: () => void; onExport: (parts: string[]) => void } = $props();
	let filter = $state('');
	/** Collapsed studios (by path). */
	let collapsed = $state<Set<string>>(new Set());
	const dark = $derived(theme.resolved === 'dark');

	type Status = 'ok' | 'warning' | 'error' | 'pending';
	const RANK: Record<Status, number> = { ok: 0, pending: 1, warning: 2, error: 3 };
	const LABEL: Record<Status, string> = { ok: 'OK', pending: 'Pending', warning: 'Warning', error: 'Error' };

	const agentBusy = (file: string, id: string) =>
		ws.agents.some((a) => (a.status === 'working' || a.status === 'writing') && ((a.detail as any)?.path === file || ws.notes.find((n) => n.id === (a.detail as any)?.noteID)?.anchor.targets.some((t) => t.part === id)));

	const JOINT_ICON = { revolute: RotateCw, slider: MoveHorizontal, cylindrical: Cylinder, planar: Move, ball: Orbit, fastened: Link2 } as const;
	const JOINT_LABEL = { revolute: 'Revolute', slider: 'Slider', cylindrical: 'Cylindrical', planar: 'Planar', ball: 'Ball', fastened: 'Fastened' } as const;
	const partName = (id: string) => ws.results[id]?.name ?? ws.partInfos.find((p) => p.id === id)?.name ?? id;

	/** A joint's current position: degrees and millimetres from where the parts are modeled. */
	function jointValue(j: AssemblyJoint, v: number[] | undefined): string {
		const q = v ?? j.value;
		const deg = (x: number) => `${num(x, 1)}°`,
			mm = (x: number) => `${num(x, 2)} mm`;
		switch (j.type) {
			case 'revolute':
				return deg(q[0]);
			case 'slider':
				return mm(q[0]);
			case 'cylindrical':
				return `${deg(q[0])} · ${mm(q[1])}`;
			case 'planar':
				return `${mm(q[0])}, ${mm(q[1])} · ${deg(q[2])}`;
			case 'ball':
				return deg(Math.hypot(q[0], q[1], q[2]));
			default:
				return '';
		}
	}

	// Parts nested under the studio that exports them; an assembly's joints under its studio.
	const tree = $derived.by(() => {
		const q = filter.trim().toLowerCase();
		return ws.partTree.flatMap(({ file, name, parts, assemblies }) => {
			const joints = assemblies.flatMap((a) =>
				a.joints.map((j) => ({ key: `${a.id}/${j.name}`, joint: j, name: `${partName(j.a)} – ${partName(j.b)}`, value: jointValue(j, ws.asm.values[a.id]?.[j.name]), parts: [j.a, j.b] }))
			);
			const members = [...new Set(joints.flatMap((j) => j.parts))];
			const asmError = ws.asm.problems.some((p) => assemblies.some((a) => a.id === p.assembly));
			const rows = parts.map(({ id }) => {
				const r = ws.results[id];
				const err = r?.problems.some((p) => p.severity === 'error');
				const warn = r?.problems.some((p) => p.severity === 'warning');
				const status: Status = ws.regen[id] === 'running' && !r ? 'pending' : err ? 'error' : warn ? 'warning' : 'ok';
				return { id, name: r?.name ?? id, status, busy: ws.regen[id] === 'running' || agentBusy(file, id) };
			});
			// a studio's name matching shows all its parts; otherwise only the matching parts
			const all = !q || name.toLowerCase().includes(q);
			const shown = all ? rows : rows.filter((r) => r.name.toLowerCase().includes(q) || r.id.includes(q));
			const shownJoints = all ? joints : joints.filter((j) => j.name.toLowerCase().includes(q));
			if (!shown.length && !shownJoints.length) return [];
			const status = rows.reduce<Status>((s, r) => (RANK[r.status] > RANK[s] ? r.status : s), asmError ? 'error' : 'ok');
			return [{ file, name, rows: shown, joints: shownJoints, ids: [...new Set([...rows.map((r) => r.id), ...members])], status, busy: rows.some((r) => r.busy) }];
		});
	});
	const selectedPart = $derived(new Set(ws.selection.map((s) => s.part)));

	/** The studio row last clicked: it (not its parts) shows as selected while the selection is still exactly its parts. */
	let clickedStudio = $state<string | null>(null);
	const directStudio = $derived.by(() => {
		const ids = ws.partTree.find((g) => g.file === clickedStudio)?.parts.map((p) => p.id);
		const sel = ws.selection;
		return ids && sel.length === ids.length && sel.every((s) => (s.kind as string) === 'part' && ids.includes(s.part)) ? clickedStudio : null;
	});
	/** The studio row whose isolate toggle made the current isolation: the icon stays on it, not its parts. */
	let isolatedStudio = $state<string | null>(null);
	const studioIsolated = (file: string, ids: string[]) => isolatedStudio === file && isolatedSet(ids);
	/** Outside the current isolation: greyed like hidden rows. */
	const outside = (ids: string[]) => ws.isolated.length > 0 && !ids.some((id) => ws.isolated.includes(id));

	// selecting parts directly hands the highlight back to them (a one-part studio's selection is otherwise identical)
	const selectParts = (ids: string[]) => (ws.select(ids.map((part) => ({ part, kind: 'part' as any, index: 0 }))), (clickedStudio = null));
	const selectStudio = (file: string, ids: string[]) => (selectParts(ids), (clickedStudio = file));
	/** Right-click selects like a click first, unless the part is already selected as a whole (not via its studio row). */
	const ctxSelect = (id: string) => (!directStudio && ws.selection.some((s) => s.part === id && (s.kind as string) === 'part')) || selectParts([id]);
	const openScript = (path: string) => ((ws.openScript = path), (ws.revealLine = null), (ws.mode = 'code'));
	function isolateStudio(file: string, ids: string[]) {
		isolatedStudio = studioIsolated(file, ids) ? null : file;
		ws.isolateMany(ids);
	}
	function isolatePart(id: string) {
		isolatedStudio = null;
		ws.isolate(id);
	}

	function toggleCollapsed(file: string) {
		const next = new Set(collapsed);
		if (!next.delete(file)) next.add(file);
		collapsed = next;
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
		return [
			{ label: 'Export…', icon: Download, onSelect: () => onExport([id]) },
			{ label: 'Copy name', icon: Copy, onSelect: () => navigator.clipboard.writeText(name).then(() => toast('Copied')) },
			// a part that shares its studio with others is removed by editing the studio
			...(siblings === 1 ? ([{ type: 'separator' }, { label: 'Delete part', icon: Trash2, destructive: true, onSelect: () => deleteStudio(file, name) }] as MenuEntry[]) : [])
		];
	}

	function studioMenu(file: string, name: string, ids: string[]): MenuEntry[] {
		return [
			{ label: 'Open code', icon: Code2, onSelect: () => openScript(file) },
			{ label: 'Export…', icon: Download, onSelect: () => onExport(ids) },
			{ type: 'separator' },
			{ label: 'Delete studio', icon: Trash2, destructive: true, onSelect: () => deleteStudio(file, name) }
		];
	}

	const isolatedSet = (ids: string[]) => ws.isolated.length === ids.length && ids.every((id) => ws.isolated.includes(id));
	/** Studios hidden from their own row: only these show eye-off, not a studio whose parts were hidden one by one. */
	let hiddenStudios = $state<string[]>([]);
	const studioHidden = (file: string, ids: string[]) => hiddenStudios.includes(file) && ids.every((id) => ws.hidden.includes(id));
	function setStudioHidden(file: string, ids: string[], hidden: boolean) {
		hiddenStudios = hidden ? [...hiddenStudios, file] : hiddenStudios.filter((f) => f !== file);
		ids.forEach((id) => ws.setHidden(id, hidden));
	}
	function setPartHidden(file: string, id: string, hidden: boolean) {
		hiddenStudios = hiddenStudios.filter((f) => f !== file);
		ws.setHidden(id, hidden);
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
		<Input size="sm" placeholder="Filter parts" bind:value={filter} aria-label="Filter parts" />
	</div>
	<div class="flex h-10 items-center pt-1 pr-2 pl-4">
		<h2 class="text-section text-fg">Parts</h2>
		<IconButton label="Add studio" size="sm" class="ml-auto" onclick={onAddStudio}><Plus /></IconButton>
	</div>
	<ul class="flex min-h-0 flex-col gap-px overflow-auto px-2 pb-2" role="tree" aria-label="Parts by studio">
		{#each tree as g (g.file)}
			{@const open = !collapsed.has(g.file) || !!filter.trim()}
			<li in:rise={{ y: -4 }} role="treeitem" aria-expanded={open} aria-selected={false} data-studio={g.file}>
				<ContextMenu items={studioMenu(g.file, g.name, g.ids)} onOpen={() => directStudio !== g.file && selectStudio(g.file, g.ids)}>
					<ListRow
						name={g.name}
						class="text-fg-secondary"
						status={g.status}
						statusLabel={LABEL[g.status]}
						busy={g.busy && !open}
						selected={directStudio === g.file}
						strong={directStudio !== g.file && g.ids.some((id) => selectedPart.has(id))}
						dimmed={outside(g.ids)}
						visible={!studioHidden(g.file, g.ids)}
						onVisibleChange={(v) => setStudioHidden(g.file, g.ids, !v)}
						isolated={studioIsolated(g.file, g.ids)}
						onIsolateChange={() => isolateStudio(g.file, g.ids)}
						onclick={() => selectStudio(g.file, g.ids)}
					>
						{#snippet leading()}
							<button
								type="button"
								class="focus-ring -m-1 inline-flex size-6 items-center justify-center rounded-sm text-fg-tertiary hover:text-fg"
								aria-label="{open ? 'Collapse' : 'Expand'} {g.name}"
								onpointerdown={(e) => e.stopPropagation()}
								onclick={(e) => (e.stopPropagation(), toggleCollapsed(g.file))}
							>
								<ChevronRight size={14} class={cn(open && 'rotate-90')} />
							</button>
						{/snippet}
					</ListRow>
				</ContextMenu>
				{#if open}
					<ul class="flex flex-col gap-px pt-px" role="group">
						{#each g.rows as r (r.id)}
							<li role="treeitem" aria-selected={selectedPart.has(r.id)}>
								<ContextMenu items={menuFor(r.id, r.name, g.file, g.ids.length)} onOpen={() => ctxSelect(r.id)}>
									<ListRow
										name={r.name}
										class="pl-6"
										color={ws.partColor(r.id, dark)}
										status={r.status}
										statusLabel={LABEL[r.status]}
										busy={r.busy}
										selected={directStudio !== g.file && selectedPart.has(r.id)}
										dimmed={outside([r.id])}
										visible={!ws.hidden.includes(r.id)}
										parentHidden={studioHidden(g.file, g.ids)}
										onVisibleChange={(v) => setPartHidden(g.file, r.id, !v)}
										isolated={!studioIsolated(g.file, g.ids) && ws.isolated.length === 1 && ws.isolated[0] === r.id}
										onIsolateChange={() => isolatePart(r.id)}
										onclick={() => selectParts([r.id])}
									/>
								</ContextMenu>
							</li>
						{/each}
						{#each g.joints as j (j.key)}
							{@const Icon = JOINT_ICON[j.joint.type]}
							<li role="treeitem" aria-selected={false} data-joint={j.joint.name}>
								<ListRow name={j.name} class="pl-6" dimmed={outside(j.parts)} onclick={() => selectParts(j.parts)} selected={directStudio !== g.file && j.parts.every((p) => selectedPart.has(p)) && ws.selection.length === 2}>
									{#snippet leading()}
										<span class="inline-flex size-4 items-center justify-center text-fg-tertiary" title={JOINT_LABEL[j.joint.type]}><Icon size={13} /></span>
									{/snippet}
									{#snippet trailing()}
										{#if j.value}<span class="pr-1 text-label text-fg-tertiary tabular-nums">{j.value}</span>{/if}
									{/snippet}
								</ListRow>
							</li>
						{/each}
					</ul>
				{/if}
			</li>
		{/each}
	</ul>
</div>
