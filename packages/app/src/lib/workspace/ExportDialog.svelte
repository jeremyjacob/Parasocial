<script lang="ts">
	import { Download, LoaderCircle } from '@lucide/svelte';
	import { Dialog } from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Select } from '$lib/components/ui/select';
	import { SegmentedControl } from '$lib/components/ui/segmented-control';
	import { toast } from '$lib/components/ui/toast';
	import type { WorkspaceState } from './state.svelte';
	import { sourcePart } from '@parasocial/runtime/protocol';
	import { bomToCSV, bomToMarkdown } from '@parasocial/runtime/bom';

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

	// drawing: one part, its views, an optional section through the middle
	let drawPartID = $state('');
	let drawFormat = $state<'pdf' | 'svg'>('pdf');
	let drawSection = $state<'none' | 'front' | 'top' | 'right'>('none');
	let drawProjection = $state<'third' | 'first'>('third');
	const drawItems = $derived(ws.parts.map((p) => ({ value: p, label: nameOf(p) })));
	const sectionItems = [
		{ value: 'none', label: 'No section' },
		{ value: 'front', label: 'Section parallel to the front' },
		{ value: 'top', label: 'Section parallel to the top' },
		{ value: 'right', label: 'Section parallel to the side' }
	];
	// bill of materials: the whole document, or an assembly with its copies counted
	let bomScope = $state('document');
	let bomFormat = $state<'csv' | 'md'>('csv');
	const bomItems = $derived([{ value: 'document', label: 'Every part' }, ...ws.asm.assemblies.map((a) => ({ value: a.id, label: `${a.name} (assembly)` }))]);

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
			drawPartID = (t.map(sourcePart).find((p) => ws.parts.includes(p)) ?? ws.parts[0] ?? '') as string;
			const asm = ws.studio?.assemblies[0];
			bomScope = asm ? asm.id : 'document';
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
			const fileName = (s: string) => s.replace(/[^\w .()-]+/g, '-').replace(/\s+/g, ' ').trim() || 'parts';
			if (what === 'document') await onZip?.();
			else if (what === 'drawing') {
				const version = ws.versions[0];
				const r = await ws.engine!.drawing(drawPartID, {
					format: drawFormat,
					projection: drawProjection,
					sections: drawSection === 'none' ? undefined : [{ plane: drawSection }],
					document: ws.doc?.name,
					version: version ? `v${version.number}` : undefined
				});
				const name = `${fileName(nameOf(drawPartID))} drawing.${drawFormat}`;
				if (r.svg !== undefined) download(new Blob([r.svg], { type: 'image/svg+xml' }), name, 'image/svg+xml');
				else download(r.pdf!, name, 'application/pdf');
				for (const w of r.warnings) toast(w);
			} else if (what === 'bom') {
				const b = await ws.engine!.bom(bomScope === 'document' ? undefined : bomScope, ws.doc?.name ?? undefined);
				const text = bomFormat === 'csv' ? bomToCSV(b) : bomToMarkdown(b);
				download(new Blob([text], { type: bomFormat === 'csv' ? 'text/csv' : 'text/markdown' }), `${fileName(b.name)} BOM.${bomFormat}`, '');
			} else {
				const bytes = await ws.engine!.exportParts($state.snapshot(chosen), format);
				const name = fileName(baseName(chosen));
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
		<SegmentedControl bind:value={what} fill items={[{ value: 'parts', text: 'Geometry' }, { value: 'drawing', text: 'Drawing' }, { value: 'bom', text: 'BOM' }, ...(onZip ? [{ value: 'document', text: 'Document' }] : [])]} />
		{#if what === 'drawing'}
			<div class="grid grid-cols-[1fr_auto] gap-2">
				<Select items={drawItems} bind:value={drawPartID} aria-label="Part to draw" />
				<SegmentedControl bind:value={drawFormat} items={[{ value: 'pdf', text: 'PDF' }, { value: 'svg', text: 'SVG' }]} class="w-44" />
				<Select items={sectionItems} bind:value={drawSection} aria-label="Section view" />
				<SegmentedControl bind:value={drawProjection} items={[{ value: 'third', text: '3rd angle' }, { value: 'first', text: '1st angle' }]} class="w-44" />
			</div>
			<p class="text-ui text-fg-secondary">Front, top, side and isometric views with hidden lines, overall dimensions and a title block.</p>
		{:else if what === 'bom'}
			<div class="grid grid-cols-[1fr_auto] gap-2">
				<Select items={bomItems} bind:value={bomScope} aria-label="Bill of materials for" />
				<SegmentedControl bind:value={bomFormat} items={[{ value: 'csv', text: 'CSV' }, { value: 'md', text: 'Markdown' }]} class="w-44" />
			</div>
			<p class="text-ui text-fg-secondary">Quantities, part numbers, materials, volume, mass and size. Set them with <code>part(name, body, {'{'} material, partNumber {'}'})</code>.</p>
		{:else if what === 'parts'}
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
		<Button variant="primary" onclick={go} disabled={busy || (what !== 'document' && !ws.kernelReady) || (what === 'parts' && !chosen.length) || (what === 'drawing' && !drawPartID)} data-testid="export-go">{#if busy}<LoaderCircle size={14} class="animate-spin" />{:else}<Download size={14} />{/if} Export</Button>
	{/snippet}
</Dialog>
