<script lang="ts">
	import { tick } from 'svelte';
	import { ChevronLeft, ChevronRight, Pause, Play, X, ListOrdered, FileCode2, ChevronDown, Plus } from '@lucide/svelte';
	import { Button, IconButton } from '$lib/components/ui/button';
	import { Slider } from '$lib/components/ui/slider';
	import { DropdownMenu, type MenuEntry } from '$lib/components/ui/menu';
	import { EmptyState } from '$lib/components/ui/feedback';
	import { rise, fadeOut } from '$lib/styles/motion';
	import type { WorkspaceState } from './state.svelte';

	let { ws, onSource }: { ws: WorkspaceState; onSource: (file: string, line: number) => void } = $props();

	const st = $derived(ws.steps);
	const n = $derived(st.steps.length);
	const build = $derived(st.build);
	const problems = $derived(build?.problems ?? []);
	const errors = $derived(problems.filter((p) => p.severity === 'error'));
	const current = $derived(st.current);

	const SPEEDS = [0.25, 0.5, 1, 2, 4];
	const speedLabel = (s: number) => `${s < 1 ? s.toFixed(2).replace(/0$/, '').replace(/^0/, '') : s}×`;
	const speedItems = $derived<MenuEntry[]>([{ type: 'label', label: 'Speed' }, ...SPEEDS.map((s) => ({ type: 'checkbox' as const, label: speedLabel(s), checked: st.speed === s, onCheckedChange: () => st.setSpeed(s) }))]);
	const buildItems = $derived<MenuEntry[]>(st.options.map((b) => ({ type: 'checkbox' as const, label: b.name, checked: b.id === build?.id, onCheckedChange: () => st.choose(b.id) })));

	/** How far step `k` has played: 0 not started, 1 done. */
	const progress = (k: number) => Math.max(0, Math.min(1, st.pos - k));

	// keep the current card in view as playback moves on
	let strip: HTMLElement | undefined = $state();
	$effect(() => {
		const k = current;
		if (!strip || k < 0) return;
		tick().then(() => strip?.querySelector<HTMLElement>(`[data-step="${k}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
	});

	async function create() {
		const path = await st.create();
		if (path) st.chosen = path.slice('builds/'.length, -'.ts'.length);
	}
	function edit() {
		const b = build;
		if (!b) return;
		const src = st.steps[current]?.source;
		onSource(b.file, src?.file === b.file ? src.line : 1);
	}
</script>

<!-- film strip -->
<aside
	class="pointer-events-auto absolute top-3 bottom-3 left-3 z-20 flex w-[232px] flex-col overflow-hidden rounded-[var(--toolbar-radius)] bg-elevated shadow-toolbar"
	aria-label="Build steps"
	data-testid="build-steps"
	in:rise={{ x: -16, y: 0, scale: 0.98, duration: 250, origin: 'left center' }}
	out:fadeOut
>
	<header class="flex h-10 shrink-0 items-center gap-1 border-b border-line-subtle pr-1 pl-3">
		<ListOrdered size={14} class="shrink-0 text-fg-secondary" />
		{#if st.options.length > 1}
			<DropdownMenu items={buildItems} align="start">
				{#snippet trigger(props)}
					<button {...props} class="focus-ring flex min-w-0 items-center gap-1 rounded-control px-1 py-0.5 text-ui font-medium hover:bg-hover">
						<span class="truncate">{build?.name ?? 'Build'}</span><ChevronDown size={12} class="shrink-0 text-fg-tertiary" />
					</button>
				{/snippet}
			</DropdownMenu>
		{:else}
			<span class="min-w-0 truncate px-1 text-ui font-medium">{build?.name ?? st.assembly?.name ?? 'Build'}</span>
		{/if}
		<span class="ml-auto flex shrink-0 items-center">
			{#if build}<IconButton label="Edit build script" size="sm" onclick={edit}><FileCode2 /></IconButton>{/if}
			<IconButton label="Close build view" shortcut={['A']} size="sm" onclick={() => st.close()}><X /></IconButton>
		</span>
	</header>

	{#if problems.length}
		<div class="flex shrink-0 flex-col gap-1 border-b border-line-subtle px-3 py-2" role={errors.length ? 'alert' : 'status'}>
			{#each problems.slice(0, 3) as p, i (i)}
				<button class="focus-ring flex items-start gap-1.5 rounded-sm text-left text-label hover:underline" onclick={() => p.source && onSource(p.source.file, p.source.line)}>
					<span class="mt-[5px] size-1.5 shrink-0 rounded-full {p.severity === 'error' ? 'bg-error' : 'bg-warning'}"></span>
					<span class="line-clamp-3 text-fg-secondary">{p.message}</span>
				</button>
			{/each}
			{#if problems.length > 3}<span class="pl-3 text-label text-fg-tertiary">and {problems.length - 3} more</span>{/if}
		</div>
	{/if}

	{#if !build}
		<div class="flex flex-1 items-center">
			<EmptyState size="panel" title="No build steps yet" description={`A build script says the order ${st.assembly?.name ?? 'the assembly'} goes together in, and how each part fits.`}>
				{#snippet action()}
					{#if !ws.readOnly}
						<Button variant="primary" size="sm" onclick={create} disabled={st.creating} data-testid="create-build-steps"><Plus size={14} /> Create build steps</Button>
					{/if}
				{/snippet}
			</EmptyState>
		</div>
	{:else if !n}
		<p class="px-3 py-4 text-label text-fg-secondary">{errors.length ? 'Fix the build script to see its steps.' : 'This build script has no steps yet.'}</p>
	{:else}
		<ol class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2 [scrollbar-width:thin]" bind:this={strip}>
			{#each st.steps as s, k (k)}
				{@const p = progress(k)}
				{@const on = k === current}
				{@const done = p >= 1 && !on}
				<li data-step={k} in:rise={{ y: 8, duration: 200, delay: Math.min(k, 8) * 30 }}>
					<button
						class="focus-ring group/card relative flex w-full flex-col overflow-hidden rounded-[8px] text-left transition-[opacity,box-shadow,background-color] duration-[var(--duration-base)] ease-out {on ? 'bg-accent-subtle shadow-[inset_0_0_0_1.5px_var(--accent)]' : 'bg-input hover:bg-hover'} {p <= 0 && !on ? 'opacity-55 hover:opacity-90' : ''}"
						onclick={() => st.go(k + 1)}
						aria-current={on ? 'step' : undefined}
						aria-label="Step {k + 1}: {s.title}"
					>
						<div class="relative aspect-[400/248] w-full overflow-hidden bg-canvas">
							{#if st.thumbs[k]}
								{#key st.thumbs[k]}<img src={st.thumbs[k]} alt="" class="absolute inset-0 size-full object-cover" in:rise={{ y: 0, scale: 1.02, duration: 250 }} />{/key}
							{:else}
								<div class="absolute inset-0 animate-pulse bg-hover"></div>
							{/if}
							<span class="absolute top-1.5 left-1.5 grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-caption font-medium tabular transition-colors duration-[var(--duration-base)] {on ? 'bg-accent text-fg-on-accent' : done ? 'bg-elevated text-fg' : 'bg-elevated text-fg-secondary'}">{k + 1}</span>
							{#if s.parts.length > 1}<span class="absolute top-1.5 right-1.5 rounded-full bg-elevated px-1.5 text-caption text-fg-secondary tabular">×{s.parts.length}</span>{/if}
						</div>
						<div class="flex flex-col gap-0.5 px-2.5 pt-2 pb-2.5">
							<span class="text-ui font-medium {s.auto ? 'text-fg-secondary italic' : ''}">{s.title}</span>
							{#if s.description}<span class="line-clamp-3 text-label text-fg-secondary">{s.description}</span>{/if}
						</div>
						<!-- this step's playback -->
						<span class="absolute inset-x-0 bottom-0 h-0.5 bg-transparent">
							<span class="block h-full origin-left bg-accent transition-opacity duration-[var(--duration-base)] {on && p < 1 ? 'opacity-100' : 'opacity-0'}" style="transform:scaleX({p})"></span>
						</span>
					</button>
				</li>
			{/each}
		</ol>
	{/if}
</aside>

<!-- transport -->
{#if n}
	<div
		class="pointer-events-auto absolute bottom-4 left-[calc(50%+122px)] z-20 flex -translate-x-1/2 items-center gap-1 rounded-[var(--toolbar-radius)] bg-elevated p-[var(--toolbar-pad)] shadow-toolbar"
		data-testid="build-bar"
		in:rise={{ y: 8, scale: 0.97, duration: 200, origin: '50% 100%' }}
		out:rise={{ y: 4, scale: 0.98, duration: 100 }}
	>
		<IconButton label="Previous step" shortcut={['ArrowLeft']} onclick={() => st.prev()} disabled={st.at <= 0}><ChevronLeft /></IconButton>
		<IconButton label={st.playing ? 'Pause' : 'Play'} shortcut={['Space']} onclick={() => st.togglePlay()} data-testid="build-play">{#if st.playing}<Pause />{:else}<Play />{/if}</IconButton>
		<IconButton label="Next step" shortcut={['ArrowRight']} onclick={() => st.next()} disabled={st.at >= n}><ChevronRight /></IconButton>
		<div class="relative mx-1.5 w-52">
			<Slider value={st.pos} min={0} max={n} step={0.001} onValueChange={(v: number) => Math.abs(v - st.pos) > 1e-3 && st.scrub(v)} onValueCommit={(v: number) => st.go(Math.round(v))} aria-label="Build progress" />
			<!-- step boundaries -->
			<span class="pointer-events-none absolute inset-x-[7px] top-1/2 h-1 -translate-y-1/2" aria-hidden="true">
				{#each { length: Math.max(0, n - 1) } as _, i (i)}
					<span class="absolute top-0 h-1 w-px bg-elevated" style="left:{((i + 1) / n) * 100}%"></span>
				{/each}
			</span>
		</div>
		<span class="w-14 text-center text-label text-fg-secondary tabular" aria-live="polite">{Math.max(0, current) + (st.pos > 0 ? 1 : 0)} / {n}</span>
		<DropdownMenu items={speedItems} side="top" align="end">
			{#snippet trigger(props)}
				<button {...props} class="focus-ring h-7 rounded-[var(--toolbar-item-radius)] px-2 text-label font-medium text-fg-secondary tabular hover:bg-hover hover:text-fg" aria-label="Playback speed">{speedLabel(st.speed)}</button>
			{/snippet}
		</DropdownMenu>
	</div>
{/if}

{#if n && current >= 0 && st.steps[current]}
	{#key current}
		<div class="pointer-events-none absolute top-3 left-[calc(50%+122px)] z-10 -translate-x-1/2 rounded-full bg-elevated/90 px-3 py-1 text-ui shadow-toolbar backdrop-blur-sm" in:rise={{ y: -6, duration: 200 }} out:fadeOut>
			<span class="text-fg-secondary tabular">Step {current + 1}</span>
			<span class="ml-1.5 font-medium">{st.steps[current].title}</span>
		</div>
	{/key}
{/if}
