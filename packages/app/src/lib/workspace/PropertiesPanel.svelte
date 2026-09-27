<script lang="ts">
	import { Copy, ArrowUpRight, SlidersHorizontal } from '@lucide/svelte';
	import { PropertySection } from '$lib/components/ui/property';
	import { Input } from '$lib/components/ui/input';
	import { Select } from '$lib/components/ui/select';
	import { IconButton } from '$lib/components/ui/button';
	import { ColorSwatch } from '$lib/components/ui/color-swatch';
	import { toast } from '$lib/components/ui/toast';
	import { mutators } from '@parasocial/sync';
	import type { EntityDescription } from '@parasocial/runtime/protocol';
	import { theme } from '$lib/theme.svelte';
	import { num } from '$lib/format';
	import type { WorkspaceState } from './state.svelte';

	let { ws }: { ws: WorkspaceState } = $props();

	const sel = $derived(ws.selection);
	const one = $derived(sel.length === 1 ? sel[0] : null);
	let desc = $state.raw<EntityDescription | null>(null);
	let descFor: string | null = null;

	$effect(() => {
		const s = one;
		const ready = ws.kernelReady;
		const key = s ? `${s.part}:${s.kind}:${s.index}:${ws.results[s.part]?.key}` : null;
		if (!s || s.kind === ('part' as any) || !ready || !ws.engine) {
			desc = null;
			return;
		}
		if (key === descFor) return;
		descFor = key;
		ws.engine.describe(s.part, s.kind, s.index).then(
			(d) => descFor === key && (desc = d),
			() => {}
		);
	});

	const row = 'grid min-h-7 grid-cols-[88px_minmax(0,1fr)] items-center gap-2 text-ui';
	const vec = (v?: number[]) => (v ? `(${v.map((x) => num(x, 3)).join(', ')})` : '—');
	const typeName: Record<string, string> = { plane: 'Planar face', cylinder: 'Cylindrical face', cone: 'Conical face', sphere: 'Spherical face', torus: 'Toroidal face', bspline: 'Freeform face', line: 'Line edge', circle: 'Circular edge', ellipse: 'Elliptical edge', bspline_edge: 'Spline edge' };

	async function copy(text: string) {
		await navigator.clipboard.writeText(text);
		toast('Copied');
	}

	function reveal(file?: string, line?: number) {
		if (!file) return;
		ws.openScript = file;
		ws.revealLine = line ?? null;
		ws.mode = 'code';
	}

	let docName = $state('');
	$effect(() => {
		docName = ws.doc?.name ?? '';
	});
	function rename() {
		const n = docName.trim();
		if (n && ws.doc && n !== ws.doc.name) ws.zero.mutate(mutators.document.rename({ id: ws.documentID, name: n }));
	}
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-auto" data-testid="properties-panel">
	{#if !sel.length}
		<PropertySection bodyClass="gap-1" title="Document">
			<label class={row}>
				<span class="text-fg-secondary">Name</span>
				<Input size="sm" bind:value={docName} onblur={rename} onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()} />
			</label>
			<div class={row}>
				<span class="text-fg-secondary">Units</span>
				<Select size="sm" items={[{ value: 'mm', label: 'Millimeters' }, { value: 'in', label: 'Inches' }]} value={ws.doc?.units ?? 'mm'} onValueChange={(v) => ws.zero.mutate(mutators.document.updateSettings({ id: ws.documentID, units: v } as any))} />
			</div>
			<div class={row}><span class="text-fg-secondary">Parts</span><span class="tabular-nums">{ws.parts.length}</span></div>
			<div class={row}><span class="text-fg-secondary">Version</span><span class="tabular-nums">v{ws.doc?.headVersion ?? 0}</span></div>
		</PropertySection>
		<p class="px-4 py-3 text-label text-fg-tertiary">Select a face, edge or part.</p>
	{:else if one && one.kind === ('part' as any)}
		{@const r = ws.results[one.part]}
		{#if r}
			<PropertySection bodyClass="gap-1" title={r.name}>
				<div class={row}>
					<span class="text-fg-secondary">Color</span>
					<span class="flex items-center gap-2"><ColorSwatch color={ws.partColor(one.part, theme.resolved === 'dark')} size={14} /> <span class="text-fg-secondary">{r.color?.kind === 'rgb' ? r.color.hex : 'Auto'}</span></span>
				</div>
				<div class={row}><span class="text-fg-secondary">Material</span><span>{r.material?.name ?? (r.material?.density ? `${r.material.density} g/cm³` : 'None')}</span></div>
				<div class={row}><span class="text-fg-secondary">Script</span><button class="focus-ring flex items-center gap-1 truncate rounded-xs text-left text-accent hover:underline" onclick={() => reveal(r.file)}>{r.file} <ArrowUpRight size={12} /></button></div>
			</PropertySection>
			{#if r.mass}
				<PropertySection bodyClass="gap-1" title="Mass properties">
					<div class={row}><span class="text-fg-secondary">Volume</span><span class="tabular-nums">{num(r.mass.volume, 1)} mm³</span></div>
					<div class={row}><span class="text-fg-secondary">Mass</span><span class="tabular-nums">{num(r.mass.mass, 2)} g</span></div>
					<div class={row}><span class="text-fg-secondary">Surface</span><span class="tabular-nums">{num(r.mass.area, 1)} mm²</span></div>
					<div class={row}><span class="text-fg-secondary">Center</span><span class="truncate tabular-nums">{vec(r.mass.centroid)}</span></div>
				</PropertySection>
			{/if}
			{#if r.bbox}
				<PropertySection bodyClass="gap-1" title="Bounding box">
					{@const size = r.bbox.max.map((v, i) => v - r.bbox!.min[i])}
					<div class={row}><span class="text-fg-secondary">Size</span><span class="tabular-nums">{size.map((v) => num(v, 2)).join(' × ')} mm</span></div>
				</PropertySection>
			{/if}
			{#if r.params.length}
				<button class="focus-ring mx-4 my-3 flex items-center gap-1.5 rounded-xs text-ui text-accent hover:underline" onclick={() => (ws.rightTab = 'params')}><SlidersHorizontal size={14} /> {r.params.length} param{r.params.length === 1 ? '' : 's'}</button>
			{/if}
		{/if}
	{:else if one}
		{@const r = ws.results[one.part]}
		{@const f = one.kind === 'face' ? r?.faces[one.index] : null}
		{@const e = one.kind === 'edge' ? r?.edges[one.index] : null}
		{@const name = desc?.name ?? r?.names?.[one.kind as 'face' | 'edge']?.[one.index]}
		<PropertySection bodyClass="gap-1" title={f ? (typeName[f.surface] ?? 'Face') : e ? (typeName[e.curve === 'bspline' ? 'bspline_edge' : e.curve] ?? 'Edge') : 'Vertex'} meta={r?.name}>
			{#if f}
				<div class={row}><span class="text-fg-secondary">Area</span><span class="tabular-nums">{num(f.area, 3)} mm²</span></div>
				{#if f.surface === 'plane'}<div class={row}><span class="text-fg-secondary">Normal</span><span class="tabular-nums">{vec(f.normal)}</span></div>{/if}
				{#if f.radius}<div class={row}><span class="text-fg-secondary">Radius</span><span class="tabular-nums">{num(f.radius, 3)} mm</span></div>{/if}
				{#if f.axis}<div class={row}><span class="text-fg-secondary">Axis</span><span class="tabular-nums">{vec(f.axis)}</span></div>{/if}
			{:else if e}
				<div class={row}><span class="text-fg-secondary">Length</span><span class="tabular-nums">{num(e.length, 3)} mm</span></div>
				{#if e.radius}<div class={row}><span class="text-fg-secondary">Radius</span><span class="tabular-nums">{num(e.radius, 3)} mm</span></div>{/if}
				{#if e.direction}<div class={row}><span class="text-fg-secondary">Direction</span><span class="tabular-nums">{vec(e.direction)}</span></div>{/if}
			{/if}
		</PropertySection>
		<PropertySection bodyClass="gap-1" title="Reference">
			{#if desc?.createdBy}
				{@const cb = desc.createdBy}
				<div class="py-1 text-ui">
					<span class="text-fg-secondary">Created by</span>
					<code class="rounded-xs bg-hover px-1 font-mono text-label">{cb.tag ?? cb.id.split('/').pop()}</code>
					<span class="text-fg-secondary">({cb.type})</span>
					{#if cb.source}
						<span class="text-fg-tertiary">·</span>
						<button class="focus-ring inline-flex items-center gap-0.5 rounded-xs text-accent hover:underline" onclick={() => reveal(cb.source?.file, cb.source?.line)} data-testid="created-by-source">{cb.source.file.split('/').pop()}:{cb.source.line} <ArrowUpRight size={12} /></button>
					{/if}
				</div>
				{#if cb.chain && cb.chain.length > 1}
					<p class="pb-1 text-label text-fg-tertiary">via {cb.chain.map((c) => `${c.file.split('/').pop()}:${c.line}`).join(' → ')}</p>
				{/if}
			{/if}
			<div class="flex items-start gap-1 py-1">
				<code class="min-w-0 flex-1 rounded-control bg-input px-2 py-1.5 font-mono text-label break-words text-fg-secondary" data-testid="stable-name">{name ?? (ws.kernelReady ? '…' : 'Loading…')}</code>
				{#if name}<IconButton label="Copy reference" size="sm" onclick={() => copy(name)}><Copy /></IconButton>{/if}
			</div>
		</PropertySection>
		{#if desc?.neighbors?.length}
			<PropertySection bodyClass="gap-1" title="Touches" collapsible open={false} meta={String(desc.neighbors.length)}>
				<ul class="flex flex-col gap-1">
					{#each desc.neighbors as n (n)}<li class="truncate font-mono text-label text-fg-secondary" title={n}>{n}</li>{/each}
				</ul>
			</PropertySection>
		{/if}
	{:else}
		<PropertySection bodyClass="gap-1" title="{sel.length} selected">
			<p class="text-ui text-fg-secondary">{[...new Set(sel.map((s) => s.kind))].join(', ')} across {new Set(sel.map((s) => s.part)).size} part{new Set(sel.map((s) => s.part)).size === 1 ? '' : 's'}.</p>
		</PropertySection>
	{/if}
</div>
