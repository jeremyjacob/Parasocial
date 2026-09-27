<script lang="ts">
	import { ArrowUp, X, LoaderCircle } from '@lucide/svelte';
	import { IconButton } from '$lib/components/ui/button';
	import type { NotesController } from './notes.svelte';
	import type { WorkspaceState } from './state.svelte';

	let { ws, nc }: { ws: WorkspaceState; nc: NotesController } = $props();
	let text = $state(nc.draft?.text ?? '');
	let el: HTMLTextAreaElement;
	const d = $derived(nc.draft!);
	const PLURAL = { face: 'faces', edge: 'edges', vertex: 'vertices' } as const;
	// "Edge of Drawer", "2 faces on Drawer", "3 features on Drawer, Lid"
	const label = $derived.by(() => {
		const parts = [...new Set(d.targets.map((t) => ws.results[t.ref.part]?.name ?? t.ref.part))].join(', ');
		const kinds = new Set(d.targets.map((t) => t.ref.kind));
		if (d.targets.length === 1) {
			const k = d.targets[0].ref.kind;
			return `${k[0].toUpperCase()}${k.slice(1)} of ${parts}`;
		}
		const noun = kinds.size === 1 ? PLURAL[[...kinds][0]] : 'features';
		return `${d.targets.length} ${noun} on ${parts}`;
	});
	// focus on appear (incl. after a pencil pause) and whenever the draft grows
	$effect(() => {
		d;
		queueMicrotask(() => el?.focus());
	});
	async function post() {
		if (!text.trim() && !nc.draftStrokeIDs.length) return;
		if (await nc.post(text.trim())) text = '';
	}
	function onkey(e: KeyboardEvent) {
		// ⌘Z/⌘⇧Z with nothing typed undo the drawing, not the text
		if (!text && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') return;
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
		<textarea bind:this={el} bind:value={text} rows="2" placeholder="Add a note…" onkeydown={onkey} data-app-undo={text ? undefined : ''} class="field-sizing-content max-h-40 min-h-10 w-full resize-none bg-transparent py-1 text-body text-fg outline-none placeholder:text-fg-tertiary" data-testid="note-text"></textarea>
		<IconButton label="Post" shortcut={['enter']} variant="accent" active size="sm" class="rounded-full" onclick={post} disabled={nc.posting} data-testid="note-post">{#if nc.posting}<LoaderCircle class="animate-spin" />{:else}<ArrowUp />{/if}</IconButton>
	</div>
</div>
