<script lang="ts">
	import { Download, LoaderCircle } from '@lucide/svelte';
	import { Dialog } from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Select } from '$lib/components/ui/select';
	import { SegmentedControl } from '$lib/components/ui/segmented-control';
	import { toast } from '$lib/components/ui/toast';
	import type { WorkspaceState } from './state.svelte';
	import { sourcePart } from '@parasocial/runtime/protocol';

	/** `target`: the parts to export when the dialog opens (a part, a studio's parts, the selection); empty = the studio in the viewport. */
	let { ws, open = $bindable(false), target = [], onZip }: { ws: WorkspaceState; open?: boolean; target?: string[]; /** Whole-document zip; members only. */ onZip?: () => Promise<void> } = $props();
	let what = $state('parts');
	let scope = $state('all');
	type Format = 'step' | 'stl' | '3mf';
	const FORMAT_PREF = 'parasocial:export-format';
	let format = $state<Format>(
		(() => {
			try {
				const v = localStorage.getItem(FORMAT_PREF);
				if (v === 'step' || v === 'stl' || v === '3mf') return v;
			} catch {}
			return 'step';
		})()
	);
	$effect(() => {
		try {
			localStorage.setItem(FORMAT_PREF, format);
		} catch {}
	});
	let busy = $state(false);

	const nameOf = (p: string) => ws.results[p]?.name ?? ws.partInfos.find((i) => i.id === sourcePart(p))?.name ?? p;
	/** File name base: the part's name for one part, the studio's when they all come from one studio, else the document's. */
	function baseName(parts: string[]) {
		if (parts.length === 1) return nameOf(parts[0]);
		const studios = new Set(parts.map((p) => ws.partTree.find((g) => g.ids.includes(p))?.name));
		const [only] = studios;
		return studios.size === 1 && only ? only : (ws.doc?.name ?? 'parts');
	}
	const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
	/** Scopes: all parts, each multi-part studio (an assembly: its instances, where they're posed), each part, and the opening target when it's none of those. */
	const scopes = $derived.by(() => {
		const out: { value: string; label: string; parts: string[] }[] = [{ value: 'all', label: `All parts (${ws.parts.length})`, parts: ws.parts }];
		for (const g of ws.partTree) if (g.ids.length > 1) out.push({ value: `studio:${g.file}`, label: `${g.name} (${g.ids.length} parts)`, parts: g.ids });
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
			const t = (target.length ? target : ws.shownParts).filter((p) => ws.allParts.includes(p));
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
			if (what === 'document') await onZip?.();
			else {
				const bytes = await ws.engine!.exportParts($state.snapshot(chosen), format);
				const name = baseName(chosen).replace(/[^\w .()-]+/g, '-').replace(/\s+/g, ' ').trim() || 'parts';
				download(bytes, `${name}.${format}`, format === 'step' ? 'model/step' : format === 'stl' ? 'model/stl' : 'model/3mf');
			}
			open = false;
		} catch (e) {
			console.error("export failed", e);
			toast.error("Couldn't export. Try again.");
		} finally {
			busy = false;
		}
	}
</script>

<Dialog bind:open title="Export">
	<div class="flex flex-col gap-3" data-testid="export-dialog">
		{#if onZip}<SegmentedControl bind:value={what} items={[{ value: 'parts', text: 'Geometry' }, { value: 'document', text: 'Document' }]} />{/if}
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
