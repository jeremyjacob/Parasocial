<script lang="ts">
	import { Download, LoaderCircle } from '@lucide/svelte';
	import { Dialog } from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Select } from '$lib/components/ui/select';
	import { SegmentedControl } from '$lib/components/ui/segmented-control';
	import { toast } from '$lib/components/ui/toast';
	import type { WorkspaceState } from './state.svelte';

	/** `target`: the parts to export when the dialog opens (a part, a script's parts, the selection); empty = all. */
	let { ws, open = $bindable(false), target = [], onZip }: { ws: WorkspaceState; open?: boolean; target?: string[]; onZip: () => Promise<void> } = $props();
	let what = $state('parts');
	let scope = $state('all');
	let format = $state<'step' | 'stl' | '3mf'>('step');
	let busy = $state(false);

	const nameOf = (p: string) => ws.results[p]?.name ?? p;
	const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
	/** Scopes: all parts, each multi-part studio, each part, and the opening target when it's none of those. */
	const scopes = $derived.by(() => {
		const out: { value: string; label: string; parts: string[] }[] = [{ value: 'all', label: `All parts (${ws.parts.length})`, parts: ws.parts }];
		for (const g of ws.partTree) if (g.parts.length > 1) out.push({ value: `studio:${g.file}`, label: `${g.name} (${g.parts.length} parts)`, parts: g.parts.map((p) => p.id) });
		for (const p of ws.parts) out.push({ value: `part:${p}`, label: nameOf(p), parts: [p] });
		return out;
	});
	let custom = $state<string[]>([]);
	const items = $derived(custom.length ? [{ value: 'custom', label: `Selection (${custom.length} parts)`, parts: custom }, ...scopes] : scopes);
	const chosen = $derived(items.find((s) => s.value === scope)?.parts ?? ws.parts);

	// each opening starts from the opener's target
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			const t = target.filter((p) => ws.parts.includes(p));
			const match = t.length ? scopes.find((s) => s.value !== 'all' && sameSet(s.parts, t)) : null;
			custom = t.length && !match && !sameSet(t, ws.parts) ? t : [];
			scope = match?.value ?? (custom.length ? 'custom' : 'all');
			what = 'parts';
		}
		wasOpen = open;
	});

	function download(bytes: Uint8Array | Blob, name: string, type: string) {
		const blob = bytes instanceof Blob ? bytes : new Blob([bytes as BlobPart], { type });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = name;
		a.click();
		setTimeout(() => URL.revokeObjectURL(a.href), 1000);
	}

	async function go() {
		busy = true;
		try {
			if (what === 'document') await onZip();
			else {
				const bytes = await ws.engine!.exportParts(chosen, format);
				const base = chosen.length === 1 ? nameOf(chosen[0]) : scope.startsWith('studio:') ? (ws.partTree.find((g) => `studio:${g.file}` === scope)?.name ?? 'parts') : (ws.doc?.name ?? 'parts');
				const name = base.replace(/[^\w.-]+/g, '-');
				download(bytes, `${name}.${format}`, format === 'step' ? 'model/step' : format === 'stl' ? 'model/stl' : 'model/3mf');
			}
			open = false;
		} catch {
			toast.error("Couldn't export. Try again.");
		} finally {
			busy = false;
		}
	}
</script>

<Dialog bind:open title="Export">
	<div class="flex flex-col gap-3" data-testid="export-dialog">
		<SegmentedControl bind:value={what} items={[{ value: 'parts', text: 'Geometry' }, { value: 'document', text: 'Document' }]} />
		{#if what === 'parts'}
			<div class="grid grid-cols-[1fr_auto] gap-2">
				<Select items={items.map(({ value, label }) => ({ value, label }))} bind:value={scope} aria-label="Parts to export" />
				<SegmentedControl bind:value={format} items={[{ value: 'step', text: 'STEP' }, { value: 'stl', text: 'STL' }, { value: '3mf', text: '3MF' }]} class="w-44" />
			</div>
		{:else}
			<p class="text-ui text-fg-secondary">Scripts, configurations and notes as a zip.</p>
		{/if}
	</div>
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
		<Button variant="primary" onclick={go} disabled={busy || (what === 'parts' && (!ws.kernelReady || !chosen.length))} data-testid="export-go">{#if busy}<LoaderCircle size={14} class="animate-spin" />{:else}<Download size={14} />{/if} Export</Button>
	{/snippet}
</Dialog>
