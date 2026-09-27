<script lang="ts">
	// Code mode (§8): Monaco split view. Unsaved edits preview live; ⌘S saves a version.
	// Selecting geometry highlights its source line; the cursor on an operation highlights its geometry.
	import { onMount, onDestroy } from 'svelte';
	import { X, Circle } from '@lucide/svelte';
	import { IconButton, Button } from '$lib/components/ui/button';
	import { toast } from '$lib/components/ui/toast';
	import { theme } from '$lib/theme.svelte';
	import { loadMonaco } from './monaco';
	import type { WorkspaceState } from './state.svelte';

	let { ws }: { ws: WorkspaceState } = $props();

	let host: HTMLDivElement;
	let editor: import('monaco-editor').editor.IStandaloneCodeEditor | null = null;
	let monaco: typeof import('monaco-editor') | null = null;
	const models = new Map<string, import('monaco-editor').editor.ITextModel>();
	const viewStates = new Map<string, unknown>();
	let current = $state<string | null>(null);
	let loading = $state(true);
	let applying = false;
	let typingTimer: any;
	let lineDecos: import('monaco-editor').editor.IEditorDecorationsCollection | null = null;
	let cursorTimer: any;

	const tabs = $derived(ws.scripts.map((s) => s.path));
	const dirty = $derived(new Set(ws.dirty));

	onMount(async () => {
		monaco = await loadMonaco();
		editor = monaco.editor.create(host, {
			automaticLayout: true,
			fontSize: 12.5,
			lineHeight: 20,
			fontFamily: "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, monospace",
			minimap: { enabled: false },
			scrollBeyondLastLine: false,
			renderLineHighlight: 'line',
			padding: { top: 8 },
			tabSize: 2,
			theme: theme.resolved === 'dark' ? 'ps-dark' : 'ps-light',
			overviewRulerBorder: false,
			guides: { indentation: false }
		});
		editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save());
		editor.onDidChangeModelContent(() => {
			if (applying || !current) return;
			ws.typing = true;
			ws.editBuffer(current, editor!.getValue());
			clearTimeout(typingTimer);
			typingTimer = setTimeout(() => (ws.typing = false), 450);
		});
		editor.onDidChangeCursorPosition((e) => {
			clearTimeout(cursorTimer);
			cursorTimer = setTimeout(() => highlightOpAt(e.position.lineNumber), 120);
		});
		lineDecos = editor.createDecorationsCollection([]);
		(globalThis as any).__editor = editor; // test hook
		loading = false;
		open(ws.openScript ?? tabs.find((t) => t.startsWith('parts/')) ?? tabs[0]);
	});

	onDestroy(() => {
		editor?.dispose();
		for (const m of models.values()) m.dispose();
		ws.typing = false;
	});

	function open(path?: string | null) {
		if (!editor || !monaco || !path) return;
		const b = ws.openBuffer(path);
		if (!b) return;
		if (current && editor.getModel()) viewStates.set(current, editor.saveViewState());
		let m = models.get(path);
		if (!m) {
			m = monaco.editor.createModel(b.content, 'typescript', monaco.Uri.parse(`file:///${path}`));
			models.set(path, m);
		}
		editor.setModel(m);
		const vs = viewStates.get(path);
		if (vs) editor.restoreViewState(vs as any);
		current = path;
		ws.openScript = path;
		editor.focus();
	}

	// external open requests (reveal source, scripts panel)
	$effect(() => {
		const p = ws.openScript;
		const line = ws.revealLine;
		if (!editor || !p) return;
		if (p !== current) open(p);
		if (line) {
			editor.revealLineInCenter(line);
			editor.setPosition({ lineNumber: line, column: 1 });
			lineDecos?.set([{ range: new monaco!.Range(line, 1, line, 1), options: { isWholeLine: true, className: 'ps-reveal-line' } }]);
		}
	});

	// synced changes: clean buffers reload in place (keeping cursor/scroll); dirty ones get a banner
	$effect(() => {
		ws.scripts;
		ws.untracked(() => {
			ws.reconcileBuffers();
			for (const [path, m] of models) {
				const b = ws.buffers[path];
				if (b && m.getValue() !== b.content) {
					const vs = path === current ? editor?.saveViewState() : null;
					applying = true;
					m.setValue(b.content);
					applying = false;
					if (vs) editor?.restoreViewState(vs);
				}
			}
		});
	});

	// problems -> markers on the offending lines
	$effect(() => {
		const probs = ws.problems;
		if (!monaco) return;
		for (const [path, m] of models) {
			monaco.editor.setModelMarkers(
				m,
				'parasocial',
				probs
					.filter((p) => p.source?.file === path)
					.map((p) => ({
						severity: p.severity === 'error' ? monaco!.MarkerSeverity.Error : monaco!.MarkerSeverity.Warning,
						message: p.message,
						startLineNumber: p.source!.line,
						endLineNumber: p.source!.line,
						startColumn: p.source!.col ?? 1,
						endColumn: 1000
					}))
			);
		}
	});

	// selecting geometry highlights its source line
	$effect(() => {
		const sel = ws.selection;
		if (!editor || !monaco || sel.length !== 1 || (sel[0].kind as string) === 'part' || !ws.engine || !ws.kernelReady) return;
		ws.engine.describe(sel[0].part, sel[0].kind, sel[0].index).then((d) => {
			const src = d.createdBy?.source;
			if (!src || !editor) return;
			if (src.file !== current) open(src.file);
			editor.revealLineInCenterIfOutsideViewport(src.line);
			lineDecos?.set([{ range: new monaco!.Range(src.line, 1, src.line, 1), options: { isWholeLine: true, className: 'ps-source-line', glyphMarginClassName: 'ps-source-glyph' } }]);
		});
	});

	/** Cursor on an operation's line highlights the geometry it made. */
	async function highlightOpAt(line: number) {
		if (!current || !ws.engine || !ws.kernelReady || !ws.viewer) return;
		const refs = [];
		for (const part of ws.parts) {
			const ops = await ws.engine.opsAtLine(part, current, line);
			for (const op of ops) for (const g of await ws.engine.fromOperation(part, op)) if (g.kind === 'face') for (const index of g.indices) refs.push({ part, kind: 'face' as const, index });
		}
		ws.viewer.setSelection(refs.length ? refs : ws.selection);
	}

	async function save() {
		if (!current) return;
		const err = await ws.saveBuffer(current);
		if (err) toast.error(err);
	}

	$effect(() => {
		monaco?.editor.setTheme(theme.resolved === 'dark' ? 'ps-dark' : 'ps-light');
	});

	// closing the tab with unsaved edits asks first
	function beforeUnload(e: BeforeUnloadEvent) {
		if (ws.dirty.length) {
			e.preventDefault();
			e.returnValue = '';
		}
	}
</script>

<svelte:window onbeforeunload={beforeUnload} />

<div class="flex min-h-0 min-w-0 flex-1 flex-col border-r border-line-subtle bg-panel" data-testid="code-editor">
	<div class="flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line-subtle px-1.5">
		{#each tabs as t (t)}
			{@const claimedBy = ws.agents.find((a) => a.status !== 'disconnected' && (a.detail as any)?.path === t)}
			<button class="focus-ring flex h-7 shrink-0 items-center gap-1.5 rounded-control px-2 text-ui transition-colors-fast {t === current ? 'bg-active font-medium' : 'text-fg-secondary hover:bg-hover'}" onclick={() => open(t)} data-testid="code-tab">
				{t.split('/').pop()}
				{#if dirty.has(t)}<Circle size={7} class="fill-current text-fg-secondary" aria-label="Unsaved" />{/if}
				{#if claimedBy}<span class="size-1.5 rounded-full bg-agent" title="{claimedBy.clientName} is editing"></span>{/if}
			</button>
		{/each}
		<IconButton label="Close code" size="sm" class="ml-auto" onclick={() => (ws.mode = 'model')}><X /></IconButton>
	</div>
	{#if current && ws.conflicts[current]}
		<div class="flex shrink-0 items-center gap-2 border-b border-line-subtle bg-warning-subtle px-3 py-1.5 text-ui" data-testid="conflict-banner">
			<span><code class="font-mono text-label">{current.split('/').pop()}</code> was changed by {ws.conflicts[current]}.</span>
			<Button size="sm" variant="ghost" class="ml-auto" onclick={() => ws.resolveConflict(current!, false)}>Reload</Button>
			<Button size="sm" onclick={() => ws.resolveConflict(current!, true)}>Keep mine</Button>
		</div>
	{/if}
	<div class="relative min-h-0 flex-1" bind:this={host}>
		{#if loading}<div class="absolute inset-0 grid place-items-center text-ui text-fg-tertiary">Loading editor…</div>{/if}
	</div>
</div>

<style>
	:global(.ps-source-line) {
		background: color-mix(in oklab, var(--color-accent) 12%, transparent);
	}
	:global(.ps-reveal-line) {
		background: color-mix(in oklab, var(--color-accent) 16%, transparent);
	}
</style>
