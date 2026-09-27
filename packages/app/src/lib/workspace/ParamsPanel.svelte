<script lang="ts">
	import { MoreHorizontal, RotateCcw, SlidersHorizontal } from '@lucide/svelte';
	import { PropertySection } from '$lib/components/ui/property';
	import { NumberField, type Evaluator } from '$lib/components/ui/number-field';
	import { Select } from '$lib/components/ui/select';
	import { IconButton, Button } from '$lib/components/ui/button';
	import { DropdownMenu, type MenuEntry } from '$lib/components/ui/menu';
	import { Dialog } from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Kbd } from '$lib/components/ui/kbd';
	import { mutators } from '@parasocial/sync';
	import { evaluate, UNITS } from '@parasocial/api/units';
	import type { ParamDecl } from '@parasocial/api/types';
	import { newID } from '$lib/zero';
	import { SHARED, type WorkspaceState } from './state.svelte';

	let { ws }: { ws: WorkspaceState } = $props();

	const configItems = $derived([{ value: 'default', label: 'Default' }, ...ws.configurations.map((c) => ({ value: c.id, label: c.name, hint: `${c.overrides.length} override${c.overrides.length === 1 ? '' : 's'}` }))]);
	let dialog = $state<null | { kind: 'create' | 'duplicate' | 'rename'; name: string }>(null);
	let dialogOpen = $state(false);
	$effect(() => {
		dialogOpen = !!dialog;
	});
	$effect(() => {
		if (!dialogOpen) dialog = null;
	});

	// shared params (one value for the document) first, once each; then those of each part in the viewport
	const groups = $derived.by(() => {
		const shared = new Map<string, ParamDecl>();
		for (const part of ws.parts) for (const p of ws.results[part]?.params ?? []) if (p.shared && !shared.has(p.name)) shared.set(p.name, { ...p, part: SHARED });
		return [
			{ part: SHARED, name: 'Shared', params: [...shared.values()] },
			...ws.shownSources.map((part) => ({ part, name: ws.results[part]?.name ?? part, params: (ws.results[part]?.params ?? []).filter((p) => !p.shared) }))
		].filter((g) => g.params.length);
	});

	/** Code default for a param: its declared default in base units. */
	function factor(p: ParamDecl) {
		return p.unit ? (UNITS[p.unit]?.factor ?? 1) : 1;
	}

	function evaluatorFor(params: ParamDecl[], p: ParamDecl): Evaluator {
		const vars: Record<string, number> = {};
		for (const q of params) if (typeof q.value === 'number') vars[q.name] = q.value;
		const unit = p.unit ? UNITS[p.unit] : UNITS.mm;
		return (input: string) => {
			try {
				const base = evaluate(input, { vars, defaultUnit: unit });
				const shown = base / factor(p);
				const plain = /^\s*-?\d*\.?\d+\s*$/.test(input);
				return { ok: true, value: shown, expression: plain ? undefined : input.trim() };
			} catch (e) {
				return { ok: false, error: (e as Error).message };
			}
		};
	}

	function commit(part: string, p: ParamDecl, value: number, expression?: string) {
		ws.endScrub();
		const expr = expression ?? String(value);
		ws.setParam(part, p.name, expr, value * factor(p));
	}

	function codeDefaultChanged(part: string, p: ParamDecl) {
		// the default in code changed under an override: the override's snapshot recorded the old default
		const o = ws.activeConfig?.overrides.find((x) => x.part === part && x.name === p.name);
		const old = o?.codeDefault;
		return old != null && old !== String(p.default) ? { old, o: o! } : null;
	}

	const configMenu = $derived<MenuEntry[]>([
		{ label: 'New configuration…', onSelect: () => (dialog = { kind: 'create', name: '' }) },
		{ label: 'Duplicate…', disabled: !ws.activeConfig, onSelect: () => (dialog = { kind: 'duplicate', name: `${ws.activeConfig?.name} copy` }) },
		{ label: 'Rename…', disabled: !ws.activeConfig, onSelect: () => (dialog = { kind: 'rename', name: ws.activeConfig?.name ?? '' }) },
		{ type: 'separator' },
		{ label: 'Reset all', disabled: !ws.activeConfig?.overrides.length, onSelect: () => ws.resetAll() },
		{
			label: 'Delete configuration',
			destructive: true,
			disabled: !ws.activeConfig,
			onSelect: () => {
				const id = ws.activeConfigID!;
				ws.setActiveConfig(null);
				ws.mutate(mutators.configuration.delete({ id }), 'Delete configuration');
			}
		}
	]);

	async function submitDialog(e: Event) {
		e.preventDefault();
		if (!dialog || !dialog.name.trim()) return;
		const name = dialog.name.trim();
		if (dialog.kind === 'create') {
			const id = newID();
			await ws.mutate(mutators.configuration.create({ id, documentID: ws.documentID, name, overrides: [] }), 'Create configuration');
			ws.setActiveConfig(id);
		} else if (dialog.kind === 'duplicate') {
			const id = newID();
			await ws.mutate(mutators.configuration.duplicate({ id, sourceID: ws.activeConfigID!, name } as any), 'Duplicate configuration');
			ws.setActiveConfig(id);
		} else await ws.mutate(mutators.configuration.rename({ id: ws.activeConfigID!, name }), 'Rename configuration');
		dialog = null;
	}
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-auto" data-testid="params-panel">
	<PropertySection title="Configuration">
		{#snippet actions()}
			<DropdownMenu items={configMenu} align="end">
				{#snippet trigger(props)}
					<IconButton {...props} label="Configuration actions" size="sm"><MoreHorizontal /></IconButton>
				{/snippet}
			</DropdownMenu>
		{/snippet}
		<Select items={configItems} value={ws.activeConfigID ?? 'default'} onValueChange={(v) => ws.setActiveConfig(v === 'default' ? null : v)} icon={SlidersHorizontal} aria-label="Active configuration" />
	</PropertySection>

	{#each groups as g (g.part)}
		{@const overrides = g.params.filter((p) => p.overridden).length}
		<PropertySection title={g.name} meta={overrides ? `${overrides} override${overrides === 1 ? '' : 's'}` : `${g.params.length} param${g.params.length === 1 ? '' : 's'}`}>
			{#snippet actions()}
				{#if overrides}
					<IconButton label="Reset all in {g.name}" size="sm" onclick={() => ws.resetAll(g.part)}><RotateCcw /></IconButton>
				{/if}
			{/snippet}
			<div class="flex flex-col gap-1">
				{#each g.params as p (p.name)}
					{@const changed = codeDefaultChanged(g.part, p)}
					{#if p.options}
						<div class="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-2">
							<span class="relative flex h-7 min-w-0 items-center text-ui transition-colors duration-[var(--duration-fast)] {p.overridden ? 'text-fg' : 'text-fg-secondary'}">
								<span aria-hidden="true" class="override-dot" data-on={p.overridden ? '' : undefined}></span>
								<span class="truncate">{p.label ?? p.name}</span>
							</span>
							<Select
								size="sm"
								items={p.options.map((o) => ({ value: String(o), label: String(o) }))}
								value={String(p.overridden ? p.expression : p.default)}
								onValueChange={(v) => (String(p.default) === v && !p.overridden ? null : ws.setParam(g.part, p.name, v, isNaN(+v) ? v : +v))}
								class={p.overridden ? 'text-override' : ''}
							/>
						</div>
					{:else}
						<NumberField
							rowLabel={p.label ?? p.name}
							value={typeof p.value === 'number' ? p.value / factor(p) : 0}
							expression={p.overridden && p.expression && !/^\s*-?\d*\.?\d+\s*$/.test(p.expression) ? p.expression : undefined}
							unit={p.unit}
							min={p.min}
							max={p.max}
							step={p.step ?? 1}
							defaultValue={typeof p.default === 'number' ? p.default : undefined}
							overridden={p.overridden}
							source={p.source ? `${p.source.file.split('/').pop()}:${p.source.line}` : undefined}
							error={p.error}
							evaluate={evaluatorFor(g.params, p)}
							oninput={(v) => ws.scrub(g.part, p.name, v * factor(p))}
							oncommit={(v, expr) => commit(g.part, p, v, expr)}
							onreset={() => ws.resetParam(g.part, p.name)}
						/>
						{#if changed}
							<p class="-mt-0.5 mb-1 flex items-center gap-2 pl-1 text-label text-warning">
								Code default changed: {changed.old} → {p.default}
								<button class="focus-ring rounded-xs font-medium text-fg-secondary hover:text-fg" onclick={() => ws.setParam(g.part, p.name, changed.o.expression, changed.o.value as number, { codeDefault: String(p.default), rebase: true })}>Keep</button>
								<button class="focus-ring rounded-xs font-medium text-fg-secondary hover:text-fg" onclick={() => ws.resetParam(g.part, p.name)}>Reset</button>
							</p>
						{/if}
					{/if}
				{/each}
			</div>
		</PropertySection>
	{:else}
		<div class="px-4 py-6 text-ui text-fg-secondary">
			{#if Object.keys(ws.results).length || !ws.parts.length}
				No params yet. Add <code class="rounded-xs bg-hover px-1 font-mono text-label">param()</code> to a script.
			{:else}
				Loading…
			{/if}
		</div>
	{/each}

	{#if ws.activeConfig?.overrides.length}
		<div class="mt-auto flex h-10 shrink-0 items-center gap-2 border-t border-line-subtle px-4 text-label text-fg-secondary">
			<span class="size-1.5 rounded-full bg-override"></span>
			<span class="tabular-nums">{ws.activeConfig.overrides.length} override{ws.activeConfig.overrides.length === 1 ? '' : 's'} in {ws.activeConfig.name}</span>
			<Button variant="ghost" size="sm" class="ml-auto" onclick={() => ws.resetAll()}>Reset all</Button>
		</div>
	{/if}
</div>

<Dialog bind:open={dialogOpen} title={dialog?.kind === 'rename' ? 'Rename configuration' : dialog?.kind === 'duplicate' ? 'Duplicate configuration' : 'New configuration'}>
	{#if dialog}
		<form id="config-form" onsubmit={submitDialog}>
			<Input bind:value={dialog.name} placeholder="Name" />
		</form>
	{/if}
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (dialog = null)}>Cancel</Button>
		<Button variant="primary" type="submit" form="config-form">{dialog?.kind === 'rename' ? 'Rename' : 'Create'}</Button>
	{/snippet}
</Dialog>
