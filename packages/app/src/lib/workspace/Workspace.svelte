<script lang="ts">
	import { onMount } from 'svelte';
	import {
		MousePointer2, MessageCircle, Pencil, Ruler, Maximize, Box, Boxes, Grid3x3, SquareDashed, Code2, Undo2, Redo2, Keyboard, Bot, Download, Plus, Sun, Moon, Eye, Scissors, ArrowLeft
	} from '@lucide/svelte';
	import { useQuery } from '@parasocial/sync/svelte';
	import { queries, mutators, type ParasocialZero } from '@parasocial/sync';
	import { TopBar } from '$lib/components/ui/top-bar';
	import { Tabs } from '$lib/components/ui/tabs';
	import { CommandPalette, type CommandGroup } from '$lib/components/ui/command';
	import { Dialog } from '$lib/components/ui/dialog';
	import { Kbd } from '$lib/components/ui/kbd';
	import { Button } from '$lib/components/ui/button';
	import { Avatar, AvatarStack, type Person } from '$lib/components/ui/avatar';
	import { Tooltip } from '$lib/components/ui/tooltip';
	import { toast } from '$lib/components/ui/toast';
	import { DropdownMenu, type MenuEntry } from '$lib/components/ui/menu';
	import { theme } from '$lib/theme.svelte';
	import { engine as getEngine } from '$lib/engine';
	import { signOut } from '$lib/auth';
	import { newID } from '$lib/zero';
	import { WorkspaceState } from './state.svelte';
	import { comboOf, comboOfKeys, isTyping, loadCustomKeys, type Command } from './commands';
	import Viewport from './Viewport.svelte';
	import PartsPanel from './PartsPanel.svelte';
	import ScriptsPanel from './ScriptsPanel.svelte';
	import HistoryPanel from './HistoryPanel.svelte';
	import PropertiesPanel from './PropertiesPanel.svelte';
	import ParamsPanel from './ParamsPanel.svelte';
	import NotesPanel from './NotesPanel.svelte';
	import CodeView from './CodeView.svelte';
	import ConnectAgentDialog from './ConnectAgentDialog.svelte';
	import { NotesController } from './notes.svelte';
	import { CompareController } from './compare.svelte';
	import CompareBar from './CompareBar.svelte';
	import { clockTime } from '$lib/format';
	import { rise, reveal } from '$lib/styles/motion';

	let { documentID, zero, user }: { documentID: string; zero: ParasocialZero; user: { userID: string; name: string } } = $props();

	const ws = new WorkspaceState({ documentID, zero, userID: user.userID });
	ws.userName = user.name;
	(globalThis as any).__ws = ws; // test hook

	const docQ = useQuery(() => queries.documents.byID({ documentID }));
	const scriptsQ = useQuery(() => queries.scripts({ documentID }));
	const configsQ = useQuery(() => queries.configurations({ documentID }));
	const versionsQ = useQuery(() => queries.versions({ documentID }));
	const notesQ = useQuery(() => queries.notes({ documentID }));
	const agentsQ = useQuery(() => queries.agentSessions({ documentID }));
	const markupQ = useQuery(() => queries.markupStrokes({ documentID }));
	const notesAllQ = useQuery(() => queries.notes({ documentID, includeRemoved: true }));
	const nc = new NotesController(ws);
	const cmp = new CompareController(ws);
	(globalThis as any).__cmp = cmp;
	(globalThis as any).__nc = nc;

	$effect(() => {
		ws.doc = (docQ.data as any) ?? null;
		ws.scripts = (scriptsQ.data as any) ?? [];
		ws.configurations = (configsQ.data as any) ?? [];
		ws.versions = (versionsQ.data as any) ?? [];
		ws.notes = (notesAllQ.data as any) ?? (notesQ.data as any) ?? [];
		nc.strokes = (markupQ.data as any) ?? [];
		ws.agents = (agentsQ.data as any) ?? [];
		if (scriptsQ.status === 'complete' && docQ.status === 'complete') ws.synced = true;
	});
	// keep a deleted active configuration from sticking
	$effect(() => {
		if (configsQ.status === 'complete' && ws.activeConfigID && !ws.configurations.some((c) => c.id === ws.activeConfigID)) ws.setActiveConfig(null);
	});

	onMount(() => {
		ws.attachEngine(getEngine());
	});

	// anything the engine consumes -> sync (latest-wins inside)
	$effect(() => {
		ws.scripts;
		ws.configurations;
		ws.activeConfigID;
		ws.live;
		ws.scrubbing;
		ws.synced;
		ws.untracked(() => ws.sync());
	});

	// re-resolve note anchors whenever geometry or notes change (§6 Resolution)
	let resolveTimer: any;
	$effect(() => {
		ws.results;
		ws.notes;
		ws.kernelReady;
		clearTimeout(resolveTimer);
		resolveTimer = setTimeout(() => nc.resolveAll(), 60);
	});

	function openNote(id: string, fly = false) {
		nc.active = id;
		ws.rightTab = 'notes';
		const n = ws.notes.find((x) => x.id === id);
		if (fly && n) ws.viewer?.setCameraState({ position: n.anchor.camera.position, target: n.anchor.camera.target, up: n.anchor.camera.up, ortho: n.anchor.camera.ortho });
	}

	/** C with a selection: note the selection directly (Figma convention). */
	function noteTool() {
		if (ws.selection.length && ws.viewer) {
			const v = ws.viewer;
			const targets = ws.selection.map((ref) => {
				const c = v.entityCenter(ref)!;
				return { ref, point: [c.x, c.y, c.z] as [number, number, number] };
			});
			const s = v.project(v.entityCenter(ws.selection[ws.selection.length - 1])!) ?? { x: 200, y: 200 };
			nc.startFromTargets(targets, s);
		}
		ws.tool = 'note';
	}

	let paletteOpen = $state(false);
	let cheatsOpen = $state(false);
	let connectOpen = $state(false);
	const notFound = $derived(docQ.status === 'complete' && !docQ.data);

	// ---- actions ----
	async function addPart() {
		const existing = new Set(ws.parts);
		let n = 1;
		while (existing.has(`part${n}`)) n++;
		const name = `part${n}`;
		const content = `import { part, param, sketch, plane, mm } from "parasocial";\n\nexport default part("Part ${n}", ({ color }) => {\n  const size = param("size", 20, { min: 1, max: 200, unit: mm });\n  return sketch(plane.XY)\n    .rect(size, size, { tag: "outline" })\n    .extrude(size / 2, { tag: "body" })\n    .color(color.auto());\n});\n`;
		await ws.zero.mutate(mutators.script.write({ documentID, path: `parts/${name}.ts`, content, baseVersion: null, message: `Add ${name}` })).client;
		toast(`Added parts/${name}.ts`);
	}

	async function exportZip() {
		const res = await fetch(`/api/documents/${documentID}/export`);
		if (!res.ok) return toast.error('Export failed');
		const blob = await res.blob();
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = `${(ws.doc?.name ?? 'document').replace(/[^\w.-]+/g, '-')}.zip`;
		a.click();
		URL.revokeObjectURL(a.href);
	}

	function openVersion(versionID: string) {
		cmp.open(versionID);
	}

	async function doUndo() {
		const l = await ws.undo();
		toast(l ? `Undid ${l}` : 'Nothing to undo');
	}
	async function doRedo() {
		const l = await ws.redo();
		toast(l ? `Redid ${l}` : 'Nothing to redo');
	}

	const commands: Command[] = [
		{ id: 'tool.select', label: 'Select', group: 'Tools', keys: ['V'], icon: MousePointer2, run: () => (ws.tool = 'select') },
		{ id: 'tool.note', label: 'Note', group: 'Tools', keys: ['C'], icon: MessageCircle, run: noteTool },
		{ id: 'tool.pencil', label: 'Pencil', group: 'Tools', keys: ['P'], icon: Pencil, run: () => (ws.tool = 'pencil') },
		{ id: 'tool.measure', label: 'Measure', group: 'Tools', keys: ['M'], icon: Ruler, run: () => (ws.tool = 'measure') },
		{ id: 'view.fit', label: 'Zoom to fit', group: 'View', keys: ['F'], icon: Maximize, run: () => (ws.selection.length ? ws.viewer?.fitSelection() : ws.viewer?.fit()) },
		{ id: 'view.iso', label: 'Isometric view', group: 'View', keys: ['0'], run: () => ws.viewer?.setView('iso') },
		{ id: 'view.front', label: 'Front view', group: 'View', keys: ['alt', 'F'], run: () => ws.viewer?.setView('front') },
		{ id: 'view.top', label: 'Top view', group: 'View', keys: ['alt', 'T'], run: () => ws.viewer?.setView('top') },
		{ id: 'view.right', label: 'Right view', group: 'View', keys: ['alt', 'R'], run: () => ws.viewer?.setView('right') },
		{ id: 'view.ortho', label: 'Toggle orthographic', group: 'View', keys: ['O'], run: () => (ws.ortho = !ws.ortho) },
		{ id: 'view.section', label: 'Section view', group: 'View', keys: ['S'], icon: Scissors, run: () => toast('Section view arrives with M6') },
		{ id: 'display.shaded', label: 'Display: shaded', group: 'View', keys: ['alt', '1'], icon: Box, run: () => (ws.display = 'shaded') },
		{ id: 'display.edges', label: 'Display: shaded with edges', group: 'View', keys: ['alt', '2'], icon: Boxes, run: () => (ws.display = 'shaded-edges') },
		{ id: 'display.wire', label: 'Display: wireframe', group: 'View', keys: ['alt', '3'], icon: Grid3x3, run: () => (ws.display = 'wireframe') },
		{ id: 'display.hidden', label: 'Display: hidden line', group: 'View', keys: ['alt', '4'], icon: SquareDashed, run: () => (ws.display = 'hidden-line') },
		{ id: 'filter.face', label: 'Select faces', group: 'Selection', keys: ['1'], run: () => (ws.filters = ['face']) },
		{ id: 'filter.edge', label: 'Select edges', group: 'Selection', keys: ['2'], run: () => (ws.filters = ['edge']) },
		{ id: 'filter.vertex', label: 'Select vertices', group: 'Selection', keys: ['3'], run: () => (ws.filters = ['vertex']) },
		{ id: 'filter.part', label: 'Select parts', group: 'Selection', keys: ['4'], run: () => (ws.filters = ['part']) },
		{ id: 'filter.all', label: 'Select faces and edges', group: 'Selection', keys: ['5'], run: () => (ws.filters = ['face', 'edge']) },
		{ id: 'sel.clear', label: 'Clear selection', group: 'Selection', keys: ['Escape'], run: () => (nc.draft ? nc.discard() : ws.tool !== 'select' ? (ws.tool = 'select') : ws.clearSelection()) },
		{ id: 'sel.showAll', label: 'Show all parts', group: 'Selection', keys: ['alt', 'H'], icon: Eye, run: () => (ws.hidden.forEach((p) => ws.setHidden(p, false)), ws.isolate(null)) },
		{ id: 'edit.undo', label: 'Undo', group: 'Edit', keys: ['mod', 'Z'], icon: Undo2, run: doUndo },
		{ id: 'edit.redo', label: 'Redo', group: 'Edit', keys: ['mod', 'shift', 'Z'], icon: Redo2, run: doRedo },
		{ id: 'mode.code', label: 'Toggle Code mode', group: 'Document', keys: ['mod', '\\'], icon: Code2, run: () => (ws.mode = ws.mode === 'code' ? 'model' : 'code') },
		{ id: 'doc.export', label: 'Export document (zip)', group: 'Document', keys: ['mod', 'shift', 'E'], icon: Download, run: exportZip },
		{ id: 'doc.addPart', label: 'Add a part', group: 'Document', icon: Plus, run: addPart },
		{ id: 'agent.connect', label: 'Connect an agent', group: 'Document', icon: Bot, run: () => (connectOpen = true) },
		{ id: 'app.palette', label: 'Command palette', group: 'Help', keys: ['mod', 'K'], run: () => (paletteOpen = true) },
		{ id: 'app.cheatsheet', label: 'Keyboard shortcuts', group: 'Help', keys: ['?'], icon: Keyboard, run: () => (cheatsOpen = true) },
		{ id: 'app.theme', label: 'Toggle theme', group: 'Help', icon: theme.resolved === 'dark' ? Sun : Moon, run: () => theme.set(theme.resolved === 'dark' ? 'light' : 'dark') },
		{ id: 'app.documents', label: 'All documents', group: 'Help', icon: ArrowLeft, run: () => (location.href = '/') }
	];
	const custom = loadCustomKeys();
	const keyOf = (c: Command) => custom[c.id] ?? c.keys;
	const byCombo = new Map(commands.filter((c) => keyOf(c)).map((c) => [comboOfKeys(keyOf(c)!), c]));

	function onKeyUp(e: KeyboardEvent) {
		if (e.key.toLowerCase() === 'b') cmp.flash(false);
	}

	function onKey(e: KeyboardEvent) {
		if (e.defaultPrevented) return;
		// hold B: flash the before state while comparing
		if (e.key.toLowerCase() === 'b' && !e.metaKey && !e.ctrlKey && cmp.against && !isTyping(e)) {
			e.preventDefault();
			if (!e.repeat) cmp.flash(true);
			return;
		}
		const combo = comboOf(e);
		const cmd = byCombo.get(combo);
		// ⌘K and Escape work everywhere; single keys never fire while typing
		const always = combo === 'mod+k' || combo === 'escape';
		if (!cmd || (isTyping(e) && !always && !combo.startsWith('mod+'))) return;
		if (combo === 'escape' && isTyping(e)) return (e.target as HTMLElement).blur();
		// text inputs own their undo; numeric fields commit on every change, so ⌘Z is the app's
		const numeric = (e.target as HTMLElement | null)?.getAttribute?.('role') === 'spinbutton';
		if (isTyping(e) && combo.includes('+z') && !numeric) return;
		if (numeric && combo.includes('+z')) (e.target as HTMLElement).blur();
		if (combo === 'escape' && (paletteOpen || cheatsOpen || connectOpen)) return;
		e.preventDefault();
		cmd.run();
	}

	// ⌘K palette: actions, views, params, parts
	const paletteGroups = $derived<CommandGroup[]>([
		...['Tools', 'View', 'Selection', 'Edit', 'Document', 'Help'].map((g) => ({
			heading: g,
			items: commands.filter((c) => c.group === g).map((c) => ({ id: c.id, label: c.label, icon: c.icon, shortcut: keyOf(c), onSelect: () => ((paletteOpen = false), c.run()) }))
		})),
		{
			heading: 'Parts',
			items: ws.parts.map((p) => ({ id: `part.${p}`, label: ws.results[p]?.name ?? p, hint: `parts/${p}.ts`, onSelect: () => ((paletteOpen = false), ws.select([{ part: p, kind: 'part' as any, index: 0 }]), ws.viewer?.fitSelection()) }))
		},
		{
			heading: 'Params',
			items: Object.values(ws.results).flatMap((r) =>
				r.params.map((p) => ({ id: `param.${r.part}.${p.name}`, label: p.name, hint: `${r.name} · ${typeof p.value === 'number' ? p.value : p.value}${p.unit ? ' ' + p.unit : ''}`, onSelect: () => ((paletteOpen = false), (ws.rightTab = 'params')) }))
			)
		},
		{
			heading: 'Configurations',
			items: [{ id: 'cfg.default', label: 'Default', hint: 'code values', onSelect: () => ((paletteOpen = false), ws.setActiveConfig(null)) }, ...ws.configurations.map((c) => ({ id: `cfg.${c.id}`, label: c.name, hint: 'configuration', onSelect: () => ((paletteOpen = false), ws.setActiveConfig(c.id)) }))]
		}
	]);

	// one avatar per agent (client + label); stale connections of the same agent collapse
	const liveAgents = $derived.by(() => {
		const byKey = new Map<string, (typeof ws.agents)[number]>();
		for (const a of ws.agents) {
			if (a.status === 'disconnected') continue;
			const k = `${a.clientName}\u0000${a.label ?? ''}`;
			const cur = byKey.get(k);
			const rank = (x: typeof a) => (x.status === 'working' || x.status === 'writing' ? 1 : 0) * 1e15 + x.lastSeenAt;
			if (!cur || rank(a) > rank(cur)) byKey.set(k, a);
		}
		return [...byKey.values()];
	});
	const agentPeople = $derived<Person[]>(liveAgents.map((a) => ({ name: `${a.clientName}${a.label ? ` (${a.label})` : ''}`, kind: 'agent', status: a.status as any })));
	const configItems = $derived([{ value: 'default', label: 'Default' }, ...ws.configurations.map((c) => ({ value: c.id, label: c.name }))]);
	let configValue = $state('default');
	$effect(() => {
		configValue = ws.activeConfigID ?? 'default';
	});
	$effect(() => {
		const v = configValue;
		ws.untracked(() => {
			if ((ws.activeConfigID ?? 'default') !== v) ws.setActiveConfig(v === 'default' ? null : v);
		});
	});

	const docMenu = $derived<MenuEntry[]>([
		{ label: 'All documents', icon: ArrowLeft, onSelect: () => (location.href = '/') },
		{ type: 'separator' },
		{ label: 'Export…', icon: Download, shortcut: ['mod', 'shift', 'E'], onSelect: exportZip },
		{ label: 'Connect an agent…', icon: Bot, onSelect: () => (connectOpen = true) },
		{ type: 'separator' },
		{
			label: 'Delete document',
			destructive: true,
			onSelect: async () => {
				if (!confirm(`Delete “${ws.doc?.name}”? This can't be undone.`)) return;
				await ws.zero.mutate(mutators.document.delete({ id: documentID })).client;
				location.href = '/';
			}
		}
	]);
	const accountMenu: MenuEntry[] = [
		{ label: 'Settings', onSelect: () => (location.href = '/settings') },
		{ type: 'separator' },
		{ label: 'Sign out', onSelect: async () => (await signOut(), (location.href = '/signin')) }
	];
	const leftTabs = $derived([
		{ value: 'parts', label: 'Parts' },
		{ value: 'scripts', label: 'Scripts' },
		{ value: 'history', label: 'History' }
	]);
	const rightTabs = $derived([
		{ value: 'properties', label: 'Properties' },
		{ value: 'params', label: 'Params' },
		{ value: 'notes', label: 'Notes', count: ws.notes.filter((n) => n.status !== 'Resolved' && !n.removedAt).length || undefined }
	]);
</script>

<svelte:window onkeydown={onKey} onkeyup={onKeyUp} />
<svelte:head><title>{ws.doc?.name ?? 'Document'} · Parasocial</title></svelte:head>

{#if notFound}
	<div class="grid h-dvh place-items-center bg-canvas">
		<div class="animate-enter flex flex-col items-center gap-3 text-center">
			<p class="text-title font-semibold">Document not found</p>
			<p class="text-ui text-fg-secondary">It may have been deleted, or you don't have access.</p>
			<Button href="/" onclick={() => (location.href = '/')}>All documents</Button>
		</div>
	</div>
{:else}
	<div class="grid h-dvh grid-rows-[auto_minmax(0,1fr)] bg-app text-fg" data-testid="workspace">
		<TopBar document={ws.doc?.name ?? ''} configurations={configItems} bind:configuration={configValue} bind:mode={ws.mode} agents={agentPeople} user={{ name: user.name, kind: 'human' }} documentMenu={docMenu} onCommand={() => (paletteOpen = true)}>
			{#snippet presence()}
				{#if agentPeople.length}
					<Tooltip label={liveAgents.map((a) => `${a.clientName}${a.label ? ` (${a.label})` : ''}: ${a.status}`).join('\n')}>
						{#snippet trigger(props)}
							<span {...props} class="mr-1 flex items-center gap-1.5" data-testid="agent-presence">
								<AvatarStack people={agentPeople} size={24} />
								<span class="text-label text-fg-secondary tabular-nums">{agentPeople.length}</span>
							</span>
						{/snippet}
					</Tooltip>
				{:else}
					<Button variant="ghost" size="sm" class="mr-1 text-fg-secondary" onclick={() => (connectOpen = true)} data-testid="connect-agent-button"><Bot size={14} /> Connect agent</Button>
				{/if}
			{/snippet}
			{#snippet account()}
				<DropdownMenu items={accountMenu} align="end">
					{#snippet trigger(props)}
						<button {...props} class="focus-ring ml-1.5 rounded-full" aria-label="Account"><Avatar name={user.name} kind="human" size={28} /></button>
					{/snippet}
				</DropdownMenu>
			{/snippet}
		</TopBar>

		<div class="grid min-h-0 grid-cols-[240px_minmax(0,1fr)_288px]">
			<aside class="flex min-h-0 flex-col border-r border-line-subtle bg-panel" aria-label="Document">
				<Tabs items={leftTabs} bind:value={ws.leftTab} class="flex min-h-0 flex-1 flex-col" listClass="border-b border-line-subtle">
					{#snippet content(tab)}
						{#if tab === 'parts'}<PartsPanel {ws} onAddPart={addPart} />
						{:else if tab === 'scripts'}<ScriptsPanel {ws} />
						{:else}<HistoryPanel {ws} onOpen={(id) => cmp.view(id)} onCompare={(id) => cmp.open(id)} viewing={cmp.viewing} />{/if}
					{/snippet}
				</Tabs>
			</aside>

			<main class="flex min-h-0 min-w-0">
				{#if ws.mode === 'code'}
					<CodeView {ws} viewScripts={cmp.viewScripts} />
				{/if}
				<div class="relative flex min-h-0 min-w-0 flex-1 flex-col">
					{#if cmp.viewing}
						{@const v = ws.versions.find((x) => x.id === cmp.viewing)}
						<div class="flex h-10 shrink-0 items-center gap-2 border-b border-line-subtle bg-accent-subtle pr-2 pl-4 text-ui" data-testid="version-banner" transition:reveal={{ duration: 150 }}>
							<span>Viewing <b class="font-medium">v{v?.number}</b> from {v ? clockTime(v.createdAt) : ''} · read-only</span>
							<Button size="sm" variant="primary" class="ml-auto" onclick={() => cmp.restore(cmp.viewing!)} data-testid="restore-version">Restore</Button>
							<Button size="sm" variant="ghost" onclick={() => cmp.back()}>Back to current</Button>
						</div>
					{/if}
					{#if cmp.against}
						<div class="pointer-events-none absolute bottom-20 left-1/2 z-20 -translate-x-1/2 [&>*]:pointer-events-auto" in:rise={{ y: 8, scale: 0.98, duration: 200, origin: '50% 100%' }} out:rise={{ y: 4, duration: 100 }}><CompareBar {ws} {cmp} /></div>
					{/if}
					<Viewport {ws} {nc} onAddPart={addPart} onConnect={() => (connectOpen = true)} onOpenNote={(id) => openNote(id)} />
				</div>
			</main>

			<aside class="flex min-h-0 flex-col border-l border-line-subtle bg-panel" aria-label="Inspector">
				<Tabs items={rightTabs} bind:value={ws.rightTab} class="flex min-h-0 flex-1 flex-col" listClass="border-b border-line-subtle">
					{#snippet content(tab)}
						{#if tab === 'properties'}<PropertiesPanel {ws} />
						{:else if tab === 'params'}<ParamsPanel {ws} />
						{:else}<NotesPanel {ws} {nc} onfocus={(id) => openNote(id, true)} onversion={openVersion} />{/if}
					{/snippet}
				</Tabs>
			</aside>
		</div>
	</div>
{/if}

<CommandPalette bind:open={paletteOpen} hotkey={false} groups={paletteGroups} placeholder="Search actions, views, params, parts…" />
<ConnectAgentDialog bind:open={connectOpen} {documentID} />
<Dialog bind:open={cheatsOpen} title="Keyboard shortcuts" class="max-w-[640px]">
	<div class="grid grid-cols-2 gap-x-8 gap-y-1" data-testid="cheatsheet">
		{#each ['Tools', 'View', 'Selection', 'Edit', 'Document', 'Help'] as g (g)}
			<div class="col-span-2 mt-2 text-label font-medium text-fg-secondary first:mt-0">{g}</div>
			{#each commands.filter((c) => c.group === g && keyOf(c)) as c (c.id)}
				<div class="flex h-7 items-center justify-between gap-3 text-ui"><span>{c.label}</span><Kbd keys={keyOf(c)!} /></div>
			{/each}
		{/each}
		<div class="col-span-2 mt-2 text-label font-medium text-fg-secondary">Viewport</div>
		<div class="flex h-7 items-center justify-between text-ui"><span>Pan</span><span class="text-label text-fg-secondary">Space-drag · middle-drag</span></div>
		<div class="flex h-7 items-center justify-between text-ui"><span>Orbit</span><span class="text-label text-fg-secondary">Right-drag · Alt-drag</span></div>
		<div class="flex h-7 items-center justify-between text-ui"><span>Add to selection</span><span class="text-label text-fg-secondary">Shift / ⌘-click</span></div>
	</div>
</Dialog>
