<script lang="ts">
	import { X, LoaderCircle } from '@lucide/svelte';
	import { Select } from '$lib/components/ui/select';
	import { Slider } from '$lib/components/ui/slider';
	import { IconButton } from '$lib/components/ui/button';
	import { Kbd } from '$lib/components/ui/kbd';
	import { clockTime } from '$lib/format';
	import type { WorkspaceState } from './state.svelte';
	import type { CompareController } from './compare.svelte';

	let { ws, cmp }: { ws: WorkspaceState; cmp: CompareController } = $props();
	const items = $derived(ws.versions.map((v) => ({ value: v.id, label: `v${v.number} · ${v.message}`, hint: clockTime(v.createdAt) })));
</script>

<div class="flex items-center gap-3 rounded-[var(--toolbar-radius)] bg-elevated p-[var(--toolbar-pad)] pl-3 shadow-toolbar" data-testid="compare-bar">
	<span class="text-ui font-medium">Compare</span>
	<Select size="sm" {items} value={cmp.against ?? ''} onValueChange={(v) => ((cmp.against = v), cmp.load())} class="w-56" aria-label="Compare with version" />
	<span class="text-label text-fg-secondary">Before</span>
	<Slider value={cmp.blend} min={0} max={1} step={0.01} onValueChange={(v: number) => cmp.setBlend(v)} class="w-36" aria-label="Before ↔ after" />
	<span class="text-label text-fg-secondary">After</span>
	<span class="flex items-center gap-1 text-label text-fg-tertiary">Hold <Kbd keys={['B']} /></span>
	{#if cmp.loading}<LoaderCircle size={14} class="animate-spin text-fg-tertiary" />{/if}
	{#if cmp.error}<span class="text-label text-error">{cmp.error}</span>{/if}
	<IconButton label="Close compare" size="sm" onclick={() => cmp.close()}><X /></IconButton>
</div>
