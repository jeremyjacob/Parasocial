<script lang="ts">
	import { cn } from '$lib/utils';
	import { onMount } from 'svelte';
	import {
		MousePointer2, MessageCircle, Pencil, Ruler, Maximize, Box, Boxes, Grid3x3, SquareDashed, Code2, Undo2, Redo2, Keyboard, Bot, Download, Plus, Sun, Moon, Eye, Scissors, ArrowLeft, Link2, LogIn
	} from '@lucide/svelte';
	import { useQuery } from '@parasocial/sync/svelte';
	import { queries, mutators, type ParasocialZero } from '@parasocial/sync';
	import { TopBar } from '$lib/components/ui/top-bar';
	import { Tabs } from '$lib/components/ui/tabs';
	import { CommandPalette, type CommandGroup } from '$lib/components/ui/command';
	import { Dialog, ConfirmDialog } from '$lib/components/ui/dialog';
	import { Kbd } from '$lib/components/ui/kbd';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
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
	import CodeEditor from './CodeEditor.svelte';
	import { prefetchMonaco } from './monaco';
	import ConnectAgentDialog from './ConnectAgentDialog.svelte';
	import ShareDialog from './ShareDialog.svelte';
	import NewStudioDialog from './NewStudioDialog.svelte';
	import ExportDialog from './ExportDialog.svelte';
	import PreferencesDialog from './PreferencesDialog.svelte';
	import { NotesController } from './notes.svelte';
	import { CompareController } from './compare.svelte';
	import CompareBar from './CompareBar.svelte';
	import ResizeHandle from './ResizeHandle.svelte';
	import { clockTime } from '$lib/format';
	import { rise, reveal } from '$lib/styles/motion';

	let {
		documentID,
		zero,
		user,
		share,
		agentConfigured = false,
		mcpConnected = false
	}: {
		documentID: string;
		zero: ParasocialZero;
		/** null: signed out (only through a share link) */
		user: { userID: string; name: string } | null;
		/** Opened through this view-only link (/s/:token): read-only, no notes, history or presence. */
		share?: string;
		agentConfigured?: boolean;
		mcpConnected?: boolean;
	} = $props();

	const ws = new WorkspaceState({ documentID, zero, userID: user?.userID ?? '', readOnly: !!share });
	ws.userName = user?.name ?? '';
	ws.agentConfigured = agentConfigured;
	ws.mcpConnected = mcpConnected;
	// follows the layout data, so a key saved from the setup dialog (invalidateAll) shows up here
	$effect.pre(() => {
		ws.agentConfigured = agentConfigured;
		ws.mcpConnected = mcpConnected;
	});
	(globalThis as any).__ws = ws; // test hook

	const docQ = useQuery(() => (share ? queries.documents.shared({ documentID, share }) : queries.documents.byID({ documentID })));
	const scriptsQ = useQuery(() => queries.scripts({ documentID, share }));
	const configsQ = useQuery(() => queries.configurations({ documentID, share }));
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
		prefetchMonaco();
	});

	// Retain the last activity after leaving; MCP treats freshness as a hint, not an open-tab guarantee.
	$effect(() => {
		if (!ws.synced || !ws.doc || ws.readOnly) return;
		const touch = () => ws.touchPresence();
		touch();
		const heartbeat = setInterval(touch, 30_000);
		window.addEventListener('focus', touch);
		return () => {
			clearInterval(heartbeat);
			window.removeEventListener('focus', touch);
		};
	});

	// anything the engine consumes -> sync (latest-wins inside)
	$effect(() => {
		ws.scripts;
		ws.configurations;
		ws.activeConfigID;
		ws.live;
		ws.scrubbing;
		ws.buffers;
		ws.typing;
		ws.synced;
		ws.untracked(() => ws.sync());
	});

	// saved assembly positions changed (a drag here, in another tab, an undo): follow them
	$effect(() => {
		ws.doc?.settings;
		ws.untracked(() => ws.asm.onSaved());
	});

	// re-resolve note anchors whenever geometry or notes change (§6 Resolution)
	let resolveTimer: any;
	$effect(() => {
		ws.results;
		ws.notes;
		ws.scripts;
		ws.kernelReady;
		clearTimeout(resolveTimer);
		resolveTimer = setTimeout(() => nc.resolveAll(), 60);
	});

	function openNote(id: string, fly = false) {
		nc.active = id;
		ws.rightTab = 'notes';
		const n = ws.notes.find((x) => x.id === id);
		if (fly && n) {
			const target = n.anchor.targets[0];
			const studio = target?.kind === 'studio' ? target.studio : target?.part ? ws.studioOf(target.part) : undefined;
			if (studio && ws.partTree.some((g) => g.file === studio)) ws.setActiveStudio(studio);
			ws.viewer?.setCameraState({ position: n.anchor.camera.position, target: n.anchor.camera.target, up: n.anchor.camera.up, ortho: n.anchor.camera.ortho });
		}
	}

	/** C with a selection: note the selection directly, staying in the current tool (Figma convention). */
	function noteTool(refs = ws.selection) {
		if (ws.dirty.length) return toast('Save to add notes');
		if (refs.length && ws.viewer) {
			const v = ws.viewer;
			const targets = refs.flatMap((ref) => {
				const center = v.entityCenter(ref);
				if (!center) return [];
				const c = v.toLocal(ref.part, center);
				return [{ ref, point: [c.x, c.y, c.z] as [number, number, number] }];
			});
			if (!targets.length) return toast('The model is still loading. Try again once it’s ready.');
			const s = v.project(v.entityCenter(targets[targets.length - 1].ref)!) ?? { x: 200, y: 200 };
			return nc.startFromTargets(targets, s);
		}
		ws.tool = 'note';
	}

	let paletteOpen = $state(false);
	let cheatsOpen = $state(false);
	/** ⌘\ hides the chrome (top bar and side panels), like Figma; panels stay mounted so their state survives. */
	let uiHidden = $state(false);
	let renameOpen = $state(false);
	let renameName = $state('');
	function rename(e?: Event) {
		e?.preventDefault();
		const name = renameName.trim();
		if (name && name !== ws.doc?.name) ws.zero.mutate(mutators.document.rename({ id: documentID, name }));
		renameOpen = false;
	}
	let connectOpen = $state(false);
	let shareOpen = $state(false);
	let exportOpen = $state(false);
	/** Parts the export dialog opens with (empty: all). */
	let exportTarget = $state<string[]>([]);
	function openExport(parts: string[] = []) {
		exportTarget = parts;
		exportOpen = true;
	}
	/** ⌘E: the selected parts, or the studio in the viewport when nothing is selected. */
	const exportSelection = () => openExport([...new Set(ws.selection.map((s) => s.part))]);
	let prefsOpen = $state(false);
	const stored = (k: string) => {
		try {
			return localStorage.getItem(k);
		} catch {
			return null;
		}
	};
	// the old "trackpad" preset was Onshape's mouse buttons plus two-finger orbit, now the defaults
	let navPreset = $state(((n) => (n && n !== 'trackpad' ? n : 'onshape'))(stored('parasocial:nav')));
	let trackpadScroll = $state(stored('parasocial:scroll') ?? 'orbit');
	$effect(() => {
		const n = navPreset,
			sc = trackpadScroll;
		try {
			localStorage.setItem('parasocial:nav', n);
			localStorage.setItem('parasocial:scroll', sc);
		} catch {}
		ws.viewer?.setNavPreset(n as any);
		ws.viewer?.setTrackpadScroll(sc as any);
	});
	// sidebar widths: null = the responsive default
	const storedWidth = (k: string) => ((n) => (Number.isFinite(n) && n > 0 ? n : null))(Number(stored(k)));
	let leftWidth = $state(storedWidth('parasocial:left-width'));
	let rightWidth = $state(storedWidth('parasocial:right-width'));
	$effect(() => {
		const entries = [['parasocial:left-width', leftWidth], ['parasocial:right-width', rightWidth]] as const;
		try {
			for (const [k, w] of entries) w == null ? localStorage.removeItem(k) : localStorage.setItem(k, String(w));
		} catch {}
	});
	const notFound = $derived(docQ.status === 'complete' && !docQ.data);

	// ---- actions ----
	/** "Add a studio": describe the part for the agent, or start blank. */
	let newStudioOpen = $state(false);
	function addStudio() {
		newStudioOpen = true;
	}

	/** Writes the next studios/studioN.ts from the template; `forAgent` marks it as a placeholder to replace. */
	async function createStudio(forAgent = false) {
		const existing = new Set(ws.scripts.map((s) => s.path));
		let n = 1;
		while (existing.has(`studios/studio${n}.ts`)) n++;
		const file = `studios/studio${n}.ts`;
		const header = forAgent ? `// Placeholder: replace it with the part described in this studio's note, and rename the studio.\n` : '';
		const content = `${header}import { part, param, sketch, plane, mm } from "parasocial";\n\nexport const name = "Studio ${n}";\n\nexport default part("Part 1", ({ color }) => {\n  const size = param("size", 20, { min: 1, max: 200, unit: mm });\n  return sketch(plane.XY)\n    .rect(size, size, { tag: "outline" })\n    .extrude(size / 2, { tag: "body" })\n    .color(color.auto());\n});\n`;
		await ws.zero.mutate(mutators.script.write({ documentID, path: file, content, baseVersion: null, message: `Add Studio ${n}` })).client;
		ws.setActiveStudio(file);
		if (!forAgent) toast(`Added Studio ${n}`);
		return { file, name: `Studio ${n}` };
	}

	async function promptStudio(text: string) {
		try {
			const { file, name } = await createStudio(true);
			await nc.postToAgent(file, text);
			toast(`The agent is building ${name}`);
			return true;
		} catch (e) {
			toast.error((e as Error).message || "Couldn't hand the part to the agent. Try again.");
			return false;
		}
	}

	async function exportZip() {
		const res = await fetch(`/api/documents/${documentID}/export`);
		if (!res.ok) return toast.error("Couldn't export. Try again.");
		const blob = await res.blob();
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = `${(ws.doc?.name ?? 'document').replace(/[^\w.-]+/g, '-')}.zip`;
		a.click();
		URL.revokeObjectURL(a.href);
	}

	function centerZ() {
		const b = ws.shownSources.flatMap((p) => (ws.results[p]?.bbox ? [ws.results[p]] : []));
		if (!b.length) return 0;
		return (Math.min(...b.map((r) => r.bbox!.min[2])) + Math.max(...b.map((r) => r.bbox!.max[2]))) / 2;
	}

	function openVersion(versionID: string) {
		cmp.open(versionID);
	}

	async function doUndo() {
		const l = await ws.undo();
		toast(l ? `Undid ${l[0].toLowerCase()}${l.slice(1)}` : 'Nothing to undo');
	}
	async function doRedo() {
		const l = await ws.redo();
		toast(l ? `Redid ${l[0].toLowerCase()}${l.slice(1)}` : 'Nothing to redo');
	}

	/** What a view-only visitor can't do. */
	const EDIT_COMMANDS = new Set(['tool.note', 'tool.pencil', 'asm.reset', 'doc.save', 'doc.addStudio', 'doc.share', 'agent.connect']);
	const allCommands: Command[] = [
		{ id: 'tool.select', label: 'Select', group: 'Tools', keys: ['V'], icon: MousePointer2, run: () => (ws.tool = 'select') },
		{ id: 'tool.note', label: 'Note', group: 'Tools', keys: ['C'], icon: MessageCircle, run: noteTool },
		{ id: 'tool.pencil', label: 'Pencil', group: 'Tools', keys: ['P'], icon: Pencil, run: () => (ws.dirty.length ? toast('Save to add notes') : (ws.tool = 'pencil')) },
		{ id: 'tool.measure', label: 'Measure', group: 'Tools', keys: ['M'], icon: Ruler, run: () => (ws.tool = 'measure') },
		{ id: 'view.fit', label: 'Zoom to fit', group: 'View', keys: ['F'], icon: Maximize, run: () => (ws.selection.length ? ws.viewer?.fitSelection() : ws.viewer?.fitOrHome()) },
		{ id: 'view.fitNormal', label: 'Zoom to, facing selected faces', group: 'View', keys: ['shift', 'F'], icon: Maximize, run: () => (ws.selection.length ? ws.viewer?.fitSelection(true, true) : ws.viewer?.fitOrHome()) },
		{ id: 'view.iso', label: 'Isometric view', group: 'View', keys: ['0'], run: () => ws.viewer?.setView('iso') },
		{ id: 'view.front', label: 'Front view', group: 'View', keys: ['alt', 'F'], run: () => ws.viewer?.setView('front') },
		{ id: 'view.top', label: 'Top view', group: 'View', keys: ['alt', 'T'], run: () => ws.viewer?.setView('top') },
		{ id: 'view.right', label: 'Right view', group: 'View', keys: ['alt', 'R'], run: () => ws.viewer?.setView('right') },
		{ id: 'view.ortho', label: 'Toggle orthographic', group: 'View', keys: ['O'], run: () => (ws.ortho = !ws.ortho) },
		{ id: 'view.section', label: 'Section view', group: 'View', keys: ['S'], icon: Scissors, run: () => ws.toggleSection(centerZ()) },
		{ id: 'view.grid', label: 'Toggle ground grid', group: 'View', keys: ['G'], run: () => ws.setHelpers({ grid: !ws.showGrid }) },
		{ id: 'view.interference', label: 'Toggle interference (red where assembly parts overlap)', group: 'View', keys: ['I'], run: () => ws.asm.setShowInterference(!ws.asm.showInterference) },
		{ id: 'view.interferenceOnTop', label: 'Toggle interference through parts (red overlaps show through what covers them)', group: 'View', run: () => ws.asm.setInterferenceOnTop(!ws.asm.interferenceOnTop) },
		{ id: 'asm.reset', label: 'Reset assembly positions', group: 'View', keywords: ['assembly', 'joints', 'pose', 'home'], run: () => ws.asm.resetPoses() },
		{ id: 'view.origin', label: 'Toggle origin', group: 'View', keys: ['shift', 'G'], run: () => ws.setHelpers({ origin: !ws.showOrigin }) },
		{ id: 'display.shaded', label: 'Display: shaded', group: 'View', keys: ['alt', '1'], icon: Box, run: () => (ws.display = 'shaded') },
		{ id: 'display.edges', label: 'Display: shaded with edges', group: 'View', keys: ['alt', '2'], icon: Boxes, run: () => (ws.display = 'shaded-edges') },
		{ id: 'display.wire', label: 'Display: wireframe', group: 'View', keys: ['alt', '3'], icon: Grid3x3, run: () => (ws.display = 'wireframe') },
		{ id: 'display.hidden', label: 'Display: hidden line', group: 'View', keys: ['alt', '4'], icon: SquareDashed, run: () => (ws.display = 'hidden-line') },
		{ id: 'sel.clear', label: 'Clear selection', group: 'Selection', keys: ['Escape'], run: () => (nc.draft ? nc.discard() : ws.tool !== 'select' ? (ws.tool = 'select') : ws.clearSelection()) },
		{ id: 'sel.none', label: 'Deselect all', group: 'Selection', keys: ['Space'], run: () => ws.clearSelection() },
		{ id: 'sel.visibility', label: 'Toggle selected parts visibility', group: 'Selection', keys: ['H'], icon: Eye, run: () => ws.setVisibility(ws.selection.map((r) => ({ part: r.part, hidden: !ws.hidden.includes(r.part) }))) },
		{ id: 'sel.showAll', label: 'Show all parts', group: 'Selection', keys: ['alt', 'H'], icon: Eye, run: () => ws.setVisibility(ws.hidden.map((part) => ({ part, hidden: false }))) },
		{ id: 'edit.undo', label: 'Undo', group: 'Edit', keys: ['mod', 'Z'], icon: Undo2, run: doUndo },
		{ id: 'edit.redo', label: 'Redo', group: 'Edit', keys: ['mod', 'shift', 'Z'], icon: Redo2, run: doRedo },
		{ id: 'mode.code', label: 'Toggle Code mode', group: 'Document', icon: Code2, run: () => (ws.mode = ws.mode === 'code' ? 'model' : 'code') },
		{ id: 'view.hideUI', label: 'Show/hide UI', group: 'View', keys: ['mod', '\\'], run: () => (uiHidden = !uiHidden) },
		{ id: 'doc.save', label: 'Save script', group: 'Document', keys: ['mod', 'S'], run: async () => { for (const p of ws.dirty) { const err = await ws.saveBuffer(p); if (err) toast.error(err); } } },
		{ id: 'doc.export', label: 'Export…', group: 'Document', keys: ['mod', 'E'], icon: Download, run: exportSelection },
		{ id: 'doc.addStudio', label: 'Add a studio', group: 'Document', icon: Plus, run: addStudio },
		{ id: 'doc.share', label: 'Share…', group: 'Document', icon: Link2, run: () => (shareOpen = true) },
		{ id: 'agent.connect', label: 'Connect an agent', group: 'Document', icon: Bot, run: () => (connectOpen = true) },
		{ id: 'app.palette', label: 'Command palette', group: 'Help', keys: ['mod', 'K'], run: () => (paletteOpen = true) },
		{ id: 'app.cheatsheet', label: 'Keyboard shortcuts', group: 'Help', keys: ['?'], icon: Keyboard, run: () => (cheatsOpen = true) },
		{ id: 'app.prefs', label: 'Preferences', group: 'Help', keys: ['mod', ','], run: () => (prefsOpen = true) },
		{ id: 'app.theme', label: 'Toggle theme', group: 'Help', icon: theme.resolved === 'dark' ? Sun : Moon, run: () => theme.set(theme.resolved === 'dark' ? 'light' : 'dark') },
		{ id: 'app.documents', label: 'All documents', group: 'Help', icon: ArrowLeft, run: () => (location.href = '/') }
	];
	const commands = ws.readOnly ? allCommands.filter((c) => !EDIT_COMMANDS.has(c.id)) : allCommands;
	let custom = $state(loadCustomKeys());
	const keyOf = (c: Command) => custom[c.id] ?? c.keys;
	const byCombo = $derived(new Map(commands.filter((c) => keyOf(c)).map((c) => [comboOfKeys(keyOf(c)!), c])));

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
		// Space on a focused button, checkbox, tab… activates it, not Deselect all
		if (combo === 'space' && (e.target as HTMLElement | null)?.closest?.('button, a[href], summary, input, [role="button"], [role="checkbox"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"], [role="radio"]')) return;
		if (combo === 'escape' && isTyping(e)) return (e.target as HTMLElement).blur();
		// text inputs own their undo; numeric fields commit on every change, so ⌘Z is the app's
		// (an empty note composer hands ⌘Z to the app too, so pencil strokes stay undoable)
		const numeric = (e.target as HTMLElement | null)?.getAttribute?.('role') === 'spinbutton';
		const appUndo = numeric || (e.target as HTMLElement | null)?.hasAttribute?.('data-app-undo');
		if (isTyping(e) && combo.includes('+z') && !appUndo) return;
		if (numeric && combo.includes('+z')) (e.target as HTMLElement).blur();
		if (combo === 'escape' && (paletteOpen || cheatsOpen || connectOpen || shareOpen || prefsOpen || exportOpen || newStudioOpen)) return;
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
			items: ws.partTree.flatMap((g) =>
				g.ids.map((p) => ({ id: `part.${p}`, label: ws.results[p]?.name ?? p, hint: g.name, onSelect: () => ((paletteOpen = false), ws.setActiveStudio(g.file), ws.select([{ part: p, kind: 'part' as any, index: 0 }]), ws.viewer?.fitSelection()) }))
			)
		},
		{
			heading: 'Params',
			items: ws.partResults.flatMap((r) =>
				r.params.map((p) => ({ id: `param.${r.part}.${p.name}`, label: p.name, hint: `${r.name} · ${typeof p.value === 'number' ? p.value : p.value}${p.unit ? ' ' + p.unit : ''}`, onSelect: () => ((paletteOpen = false), (ws.rightTab = 'params')) }))
			)
		},
		{
			heading: 'Configurations',
			items: [{ id: 'cfg.default', label: 'Default', onSelect: () => ((paletteOpen = false), ws.setActiveConfig(null)) }, ...ws.configurations.map((c) => ({ id: `cfg.${c.id}`, label: c.name, onSelect: () => ((paletteOpen = false), ws.setActiveConfig(c.id)) }))]
		}
	]);

	// one avatar per agent (client + label); stale connections of the same agent collapse. The
	// built-in agent runs one session per note: each one working gets its own avatar.
	const liveAgents = $derived.by(() => {
		const byKey = new Map<string, (typeof ws.agents)[number]>();
		for (const a of ws.agents) {
			if (a.status === 'disconnected') continue;
			const busy = a.status === 'working' || a.status === 'writing';
			const k = a.builtin && busy ? a.id : `${a.clientName}\u0000${a.label ?? ''}`;
			const cur = byKey.get(k);
			const rank = (x: typeof a) => (x.status === 'working' || x.status === 'writing' ? 1 : 0) * 1e15 + x.lastSeenAt;
			if (!cur || rank(a) > rank(cur)) byKey.set(k, a);
		}
		return [...byKey.values()];
	});
	const agentPeople = $derived<Person[]>(liveAgents.map((a) => ({ name: `${a.clientName}${a.label ? ` (${a.label})` : ''}`, kind: 'agent', status: a.status as any })));

	let deleteOpen = $state(false);
	async function deleteDocument() {
		await ws.zero.mutate(mutators.document.delete({ id: documentID })).client;
		location.href = '/';
	}
	const docMenu = $derived<MenuEntry[]>(ws.readOnly ? [{ label: 'Export…', icon: Download, shortcut: ['mod', 'E'], onSelect: exportSelection }] : [
		{ label: 'Rename…', icon: Pencil, onSelect: () => ((renameName = ws.doc?.name ?? ''), (renameOpen = true)) },
		{ label: 'Share…', icon: Link2, onSelect: () => (shareOpen = true) },
		{ label: 'Export…', icon: Download, shortcut: ['mod', 'E'], onSelect: exportSelection },
		{ type: 'separator' },
		{
			label: 'Delete document',
			destructive: true,
			onSelect: () => (deleteOpen = true)
		}
	]);
	const accountMenu: MenuEntry[] = [
		{ label: 'Preferences…', onSelect: () => (prefsOpen = true) },
		{ label: 'Settings', onSelect: () => (location.href = '/settings') },
		{ type: 'separator' },
		{ label: 'Sign out', onSelect: async () => (await signOut(), (location.href = '/signin')) }
	];
	const leftTabs = $derived([
		{ value: 'parts', label: 'Studios' },
		{ value: 'scripts', label: 'Scripts' },
		...(ws.readOnly ? [] : [{ value: 'history', label: 'History' }])
	]);
	const rightTabs = $derived([
		{ value: 'properties', label: 'Properties' },
		{ value: 'params', label: 'Params' },
		...(ws.readOnly ? [] : [{ value: 'notes', label: 'Notes', count: ws.notes.filter((n) => n.status !== 'Resolved' && !n.removedAt).length || undefined }])
	]);
	const signInHref = $derived(`/signin?next=${encodeURIComponent(share ? `/s/${share}` : `/d/${documentID}`)}`);
</script>

<svelte:window onkeydown={onKey} onkeyup={onKeyUp} />
<svelte:head><title>{ws.doc?.name ?? 'Document'} · Parasocial</title></svelte:head>

{#if notFound}
	<div class="grid h-dvh place-items-center bg-canvas">
		<div class="animate-enter flex flex-col items-center gap-3 text-center">
			{#if share}
				<p class="text-title font-heading font-medium">This link doesn't work anymore</p>
				<p class="text-ui text-fg-secondary">Link sharing may have been turned off. Ask for a new link.</p>
			{:else}
				<p class="text-title font-heading font-medium">Document not found</p>
				<p class="text-ui text-fg-secondary">It may have been deleted, or you don't have access.</p>
			{/if}
			{#if user}<Button href="/" onclick={() => (location.href = '/')}>All documents</Button>{/if}
		</div>
	</div>
{:else}
	<div class={cn('grid h-dvh min-w-0 overflow-hidden bg-app text-fg', uiHidden ? 'grid-rows-[minmax(0,1fr)]' : 'grid-rows-[auto_minmax(0,1fr)]')} data-testid="workspace">
		{#if !uiHidden}
		<TopBar document={ws.doc?.name ?? ''} bind:mode={ws.mode} agents={agentPeople} user={{ name: user?.name ?? '', kind: 'human' }} documentMenu={docMenu} onCommand={() => (paletteOpen = true)}>
			{#snippet presence()}
				{#if ws.readOnly}
					<span class="mr-2 flex items-center gap-1.5 text-label text-fg-secondary" data-testid="view-only"><Eye size={14} /> View only</span>
				{:else if agentPeople.length}
					<Tooltip label={liveAgents.map((a) => `${a.clientName}${a.label ? ` (${a.label})` : ''}: ${a.status}`).join('\n')}>
						{#snippet trigger(props)}
							<button {...props} type="button" class="focus-ring mr-1 flex items-center gap-1.5 rounded-md py-0.5 pr-1.5 pl-0.5 hover:bg-hover active:bg-active" onclick={(e) => { (props.onclick as ((e: MouseEvent) => void) | undefined)?.(e); connectOpen = true; }} aria-label="Connect an agent" data-testid="agent-presence">
								<AvatarStack people={agentPeople} size={24} />
								<span class="text-label text-fg-secondary tabular-nums">{agentPeople.length}</span>
							</button>
						{/snippet}
					</Tooltip>
				{:else}
					<Button variant="ghost" size="sm" class="mr-1 text-fg-secondary" onclick={() => (connectOpen = true)} data-testid="connect-agent-button"><Bot size={14} /> Connect agent</Button>
				{/if}
			{/snippet}
			{#snippet actions()}
				{#if !ws.readOnly}
					<Button size="sm" class="ml-1" onclick={() => (shareOpen = true)} data-testid="share-button"><Link2 size={14} /> Share</Button>
				{/if}
			{/snippet}
			{#snippet account()}
				{#if user}
					<DropdownMenu items={accountMenu} align="end">
						{#snippet trigger(props)}
							<button {...props} class="focus-ring ml-1.5 rounded-full" aria-label="Account"><Avatar name={user.name} kind="human" size={28} /></button>
						{/snippet}
					</DropdownMenu>
				{:else}
					<Button size="sm" variant="primary" class="ml-1.5" href={signInHref} data-testid="share-sign-in"><LogIn size={14} /> Sign in</Button>
				{/if}
			{/snippet}
		</TopBar>
		{/if}

		<div
			class={cn('grid min-h-0 min-w-0', uiHidden ? 'grid-cols-1' : 'grid-cols-[var(--left-w,240px)_minmax(0,1fr)_var(--right-w,256px)] 2xl:grid-cols-[var(--left-w,240px)_minmax(0,1fr)_var(--right-w,288px)]')}
			style:--left-w={leftWidth ? `${leftWidth}px` : undefined}
			style:--right-w={rightWidth ? `${rightWidth}px` : undefined}
		>
			<aside class={cn('relative flex min-h-0 min-w-0 flex-col border-r border-line-subtle bg-panel', uiHidden && 'hidden')} aria-label="Document">
				<Tabs items={leftTabs} bind:value={ws.leftTab} class="flex min-h-0 flex-1 flex-col" listClass="border-b border-line">
					{#snippet content(tab)}
						{#if tab === 'parts'}<PartsPanel {ws} onAddStudio={addStudio} onExport={openExport} onAddStudioNote={(file) => nc.startFromStudio(file)} onAddNote={(parts) => noteTool(parts.map((part) => ({ part, kind: 'part' as any, index: 0 })))} />
						{:else if tab === 'scripts'}<ScriptsPanel {ws} />
						{:else}<HistoryPanel {ws} onOpen={(id) => cmp.view(id)} onCompare={(id) => cmp.open(id)} viewing={cmp.viewing} />{/if}
					{/snippet}
				</Tabs>
				<ResizeHandle side="left" bind:width={leftWidth} label="Resize document panel" />
			</aside>

			<main class="flex min-h-0 min-w-0">
				{#if ws.mode === 'code'}
					{#if cmp.viewScripts}<CodeView {ws} viewScripts={cmp.viewScripts} />{:else if ws.readOnly}<CodeView {ws} />{:else}<CodeEditor {ws} />{/if}
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
						<div class="pointer-events-none absolute bottom-20 left-1/2 z-20 -translate-x-1/2 *:pointer-events-auto" in:rise={{ y: 8, scale: 0.98, duration: 200, origin: '50% 100%' }} out:rise={{ y: 4, duration: 100 }}><CompareBar {ws} {cmp} /></div>
					{/if}
					<Viewport {ws} {nc} onAddStudio={addStudio} onConnect={() => (connectOpen = true)} onOpenNote={(id) => openNote(id)} />
				</div>
			</main>

			<aside class={cn('relative flex min-h-0 min-w-0 flex-col border-l border-line-subtle bg-panel', uiHidden && 'hidden')} aria-label="Inspector">
				<Tabs items={rightTabs} bind:value={ws.rightTab} class="flex min-h-0 flex-1 flex-col" listClass="border-b border-line">
					{#snippet content(tab)}
						{#if tab === 'properties'}<PropertiesPanel {ws} />
						{:else if tab === 'params'}<ParamsPanel {ws} />
						{:else}<NotesPanel {ws} {nc} onfocus={(id) => openNote(id, true)} onversion={openVersion} />{/if}
					{/snippet}
				</Tabs>
				<ResizeHandle side="right" bind:width={rightWidth} label="Resize inspector panel" />
			</aside>
		</div>
	</div>
{/if}

<CommandPalette bind:open={paletteOpen} hotkey={false} groups={paletteGroups} placeholder="Search…" />
<ConnectAgentDialog bind:open={connectOpen} {documentID} documentName={ws.doc?.name} />
<NewStudioDialog bind:open={newStudioOpen} onPrompt={promptStudio} onBlank={async () => void (await createStudio())} onConnect={() => (connectOpen = true)} />
<PreferencesDialog bind:open={prefsOpen} {commands} bind:custom bind:nav={navPreset} bind:scroll={trackpadScroll} bind:additiveSelection={ws.additiveSelection} />
<ExportDialog {ws} bind:open={exportOpen} target={exportTarget} onZip={ws.readOnly ? undefined : async () => void (await exportZip())} />
{#if !ws.readOnly}<ShareDialog bind:open={shareOpen} {ws} />{/if}
<ConfirmDialog bind:open={deleteOpen} title={`Delete “${ws.doc?.name}”?`} description="This can't be undone." onconfirm={deleteDocument} />
<Dialog bind:open={renameOpen} title="Rename document">
	<form id="rename-doc" onsubmit={rename} class="flex flex-col gap-1.5">
		<span class="text-label text-fg-secondary">Name</span>
		<Input bind:value={renameName} data-testid="rename-document-name" />
	</form>
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (renameOpen = false)}>Cancel</Button>
		<Button variant="primary" type="submit" form="rename-doc" disabled={!renameName.trim()} data-testid="rename-document">Rename</Button>
	{/snippet}
</Dialog>
<Dialog bind:open={cheatsOpen} title="Keyboard shortcuts" class="max-w-[640px]">
	<div class="grid grid-cols-2 gap-x-8 gap-y-1" data-testid="cheatsheet">
		{#each ['Tools', 'View', 'Selection', 'Edit', 'Document', 'Help'] as g (g)}
			<div class="col-span-2 mt-2 text-label font-medium text-fg-secondary first:mt-0">{g}</div>
			{#each commands.filter((c) => c.group === g && keyOf(c)) as c (c.id)}
				<div class="flex h-7 items-center justify-between gap-3 text-ui"><span>{c.label}</span><Kbd keys={keyOf(c)!} /></div>
			{/each}
		{/each}
		<div class="col-span-2 mt-2 text-label font-medium text-fg-secondary">Viewport</div>
		<div class="flex h-7 items-center justify-between text-ui"><span>Pan</span><span class="text-label text-fg-secondary">Middle-drag · {trackpadScroll === 'pan' ? 'Two-finger scroll' : 'Shift + two-finger scroll'}</span></div>
		<div class="flex h-7 items-center justify-between text-ui"><span>Orbit</span><span class="text-label text-fg-secondary">Right-drag · Alt-drag · {trackpadScroll === 'pan' ? 'Shift + two-finger scroll' : 'Two-finger scroll'}</span></div>
		<div class="flex h-7 items-center justify-between text-ui"><span>Zoom</span><span class="text-label text-fg-secondary">Wheel · Pinch · ⌘ + two-finger scroll</span></div>
		<div class="flex h-7 items-center justify-between text-ui"><span>Add to selection</span><span class="text-label text-fg-secondary">{ws.additiveSelection ? 'Click' : 'Shift / ⌘ / Ctrl-click'}</span></div>
	</div>
</Dialog>
