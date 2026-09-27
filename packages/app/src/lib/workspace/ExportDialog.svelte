<script lang="ts">
	import { Download, LoaderCircle } from '@lucide/svelte';
	import { Dialog } from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Select } from '$lib/components/ui/select';
	import { SegmentedControl } from '$lib/components/ui/segmented-control';
	import { toast } from '$lib/components/ui/toast';
	import type { WorkspaceState } from './state.svelte';

	let { ws, open = $bindable(false), onZip }: { ws: WorkspaceState; open?: boolean; onZip: () => Promise<void> } = $props();
	let what = $state('part');
	let part = $state('');
	let format = $state<'step' | 'stl' | '3mf'>('step');
	let busy = $state(false);
	$effect(() => {
		if (open && !part) part = ws.selection[0]?.part ?? ws.parts[0] ?? '';
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
				const bytes = await ws.engine!.exportPart(part, format);
				const name = (ws.results[part]?.name ?? part).replace(/[^\w.-]+/g, '-');
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
		<SegmentedControl bind:value={what} items={[{ value: 'part', text: 'Part' }, { value: 'document', text: 'Document' }]} />
		{#if what === 'part'}
			<div class="grid grid-cols-[1fr_auto] gap-2">
				<Select items={ws.parts.map((p) => ({ value: p, label: ws.results[p]?.name ?? p }))} bind:value={part} aria-label="Part" />
				<SegmentedControl bind:value={format} items={[{ value: 'step', text: 'STEP' }, { value: 'stl', text: 'STL' }, { value: '3mf', text: '3MF' }]} class="w-44" />
			</div>
		{:else}
			<p class="text-ui text-fg-secondary">Scripts, configurations and notes as a zip.</p>
		{/if}
	</div>
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
		<Button variant="primary" onclick={go} disabled={busy || (what === 'part' && !ws.kernelReady)} data-testid="export-go">{#if busy}<LoaderCircle size={14} class="animate-spin" />{:else}<Download size={14} />{/if} Export</Button>
	{/snippet}
</Dialog>
