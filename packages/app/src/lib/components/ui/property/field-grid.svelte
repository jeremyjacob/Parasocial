<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';

	type Props = {
		/** Number of equal field columns. */
		cols?: 1 | 2 | 3;
		/** Reserve a trailing 28px column for a row action icon (Figma's right-edge icons). */
		action?: Snippet;
		children: Snippet;
		class?: string;
	};
	let { cols = 2, action, children, class: className }: Props = $props();
	const template = $derived(
		`repeat(${cols}, minmax(0, 1fr))` + (action ? ' 28px' : '')
	);
</script>

<div class={cn('grid items-start gap-2', className)} style="grid-template-columns:{template}">
	{@render children()}
	{#if action}<div class="flex h-7 items-center justify-center">{@render action()}</div>{/if}
</div>
