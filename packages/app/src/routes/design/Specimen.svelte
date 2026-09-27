<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';
	type Props = {
		title: string;
		note?: string;
		children: Snippet;
		class?: string;
		/** Content area background: panel (default) or canvas (viewport chrome). */
		surface?: 'panel' | 'canvas';
		bodyClass?: string;
	};
	let { title, note, children, class: className, surface = 'panel', bodyClass }: Props = $props();
</script>

<figure
	class={cn(
		'flex min-w-0 flex-col overflow-hidden rounded-panel bg-panel shadow-[0_0_0_1px_var(--border-subtle),0_1px_2px_rgb(0_0_0/0.03)]',
		className
	)}
>
	<figcaption class="flex h-9 items-center gap-2 border-b border-line-subtle px-4">
		<span class="text-label font-semibold text-fg">{title}</span>
		{#if note}<span class="truncate text-label text-fg-tertiary">{note}</span>{/if}
	</figcaption>
	<div class={cn('flex flex-1 flex-col gap-3 p-4', surface === 'canvas' && 'bg-canvas', bodyClass)}>
		{@render children()}
	</div>
</figure>
