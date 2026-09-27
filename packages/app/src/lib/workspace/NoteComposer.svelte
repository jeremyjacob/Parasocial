<script lang="ts">
	import { ArrowUp, X, LoaderCircle } from '@lucide/svelte';
	import { IconButton } from '$lib/components/ui/button';
	import type { NotesController } from './notes.svelte';
	import type { WorkspaceState } from './state.svelte';

	let { ws, nc }: { ws: WorkspaceState; nc: NotesController } = $props();
	let text = $state(nc.draft?.text ?? '');
	let el: HTMLTextAreaElement;
	const d = $derived(nc.draft!);
	const label = $derived.by(() => {
		const parts = [...new Set(d.targets.map((t) => ws.results[t.ref.part]?.name ?? t.ref.part))];
		return parts.join(', ');
	});
	$effect(() => {
		d;
		if (ws.tool !== 'pencil') queueMicrotask(() => el?.focus());
	});
	async function post() {
		if (!text.trim() && !nc.draftStrokeIDs.length) return;
		if (await nc.post(text.trim())) text = '';
	}
	function onkey(e: KeyboardEvent) {
		e.stopPropagation();
		if (e.key === 'Enter' && !e.shiftKey) (e.preventDefault(), post());
		if (e.key === 'Escape') (e.preventDefault(), nc.discard());
	}
</script>

<div class="w-[280px] rounded-dialog border border-line-subtle bg-elevated p-2 shadow-popover" data-testid="note-composer" role="dialog" aria-label="New note">
	<div class="mb-1 flex h-6 items-center gap-1 pr-1 pl-2.5 text-label text-fg-secondary">
		<span class="truncate">{label}</span>
		<IconButton label="Discard" shortcut={['esc']} size="sm" class="ml-auto" onclick={() => nc.discard()}><X /></IconButton>
	</div>
	<div class="field h-auto min-h-8 items-end gap-1 py-1 pr-1 pl-2.5">
		<textarea bind:this={el} bind:value={text} rows="2" placeholder="Add a note…" onkeydown={onkey} class="field-sizing-content max-h-40 min-h-10 w-full resize-none bg-transparent py-1 text-body text-fg outline-none placeholder:text-fg-tertiary" data-testid="note-text"></textarea>
		<IconButton label="Post" shortcut={['enter']} variant="accent" active size="sm" class="rounded-full" onclick={post} disabled={nc.posting} data-testid="note-post">{#if nc.posting}<LoaderCircle class="animate-spin" />{:else}<ArrowUp />{/if}</IconButton>
	</div>
</div>
