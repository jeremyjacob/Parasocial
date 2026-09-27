<script lang="ts">
	// Read-only source view (Code mode's viewer until the Monaco editor lands in M6): line numbers,
	// the revealed line highlighted, error markers from regeneration problems.
	import { tick } from 'svelte';
	import { X } from '@lucide/svelte';
	import { IconButton } from '$lib/components/ui/button';
	import type { WorkspaceState } from './state.svelte';

	let { ws }: { ws: WorkspaceState } = $props();
	let scroller: HTMLDivElement;
	const path = $derived(ws.openScript ?? ws.scripts.find((s) => s.path.startsWith('parts/'))?.path ?? null);
	const script = $derived(ws.scripts.find((s) => s.path === path));
	const lines = $derived(script?.content.split('\n') ?? []);
	const markers = $derived(
		new Map(
			ws.problems
				.filter((p) => p.source?.file === path)
				.map((p) => [p.source!.line, p] as const)
		)
	);

	$effect(() => {
		const l = ws.revealLine;
		lines;
		if (!l) return;
		tick().then(() => scroller?.querySelector(`[data-line="${l}"]`)?.scrollIntoView({ block: 'center' }));
	});
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col border-r border-line-subtle bg-panel" data-testid="code-view">
	<div class="flex h-9 shrink-0 items-center gap-1 border-b border-line-subtle px-2">
		{#each ws.scripts as s (s.id)}
			<button class="focus-ring h-7 rounded-control px-2 text-ui transition-colors-fast {s.path === path ? 'bg-active font-medium' : 'text-fg-secondary hover:bg-hover'}" onclick={() => ((ws.openScript = s.path), (ws.revealLine = null))}>{s.path.split('/').pop()}</button>
		{/each}
		<IconButton label="Close code" size="sm" class="ml-auto" onclick={() => (ws.mode = 'model')}><X /></IconButton>
	</div>
	<div class="min-h-0 flex-1 overflow-auto py-2 font-mono text-[12px] leading-[20px]" bind:this={scroller}>
		{#each lines as text, i (i)}
			{@const n = i + 1}
			{@const m = markers.get(n)}
			<div class="flex {ws.revealLine === n ? 'bg-accent-subtle' : ''} {m ? (m.severity === 'error' ? 'bg-error/8' : 'bg-warning/8') : ''}" data-line={n}>
				<span class="w-12 shrink-0 pr-3 text-right text-fg-tertiary tabular-nums select-none">{n}</span>
				<span class="whitespace-pre text-fg">{text || ' '}</span>
				{#if m}<span class="ml-4 truncate pr-3 {m.severity === 'error' ? 'text-error' : 'text-warning'}" title={m.message}>● {m.message}</span>{/if}
			</div>
		{/each}
	</div>
	<div class="flex h-7 shrink-0 items-center border-t border-line-subtle px-3 text-label text-fg-tertiary">Read-only · editing lands with the Monaco editor (M6)</div>
</div>
