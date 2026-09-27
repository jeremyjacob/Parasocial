<script lang="ts">
	import { cn, keyGlyph } from '$lib/utils';

	type Props = {
		/** Keys in order, e.g. ['mod', 'k'] or ['shift', 'P']. Tokens map to platform glyphs. */
		keys: string[];
		/** `chip`: bordered key caps (menus, docs). `inline`: bare glyphs (tooltips, dark surfaces). */
		variant?: 'chip' | 'inline';
		class?: string;
	};
	let { keys, variant = 'chip', class: className }: Props = $props();
</script>

<kbd
	class={cn('inline-flex items-center gap-0.5 font-sans font-medium not-italic tabular', className)}
	aria-label={keys.join('+')}
>
	{#each keys as key, i (i)}
		{#if variant === 'chip'}
			<span
				class="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-sm bg-panel px-1 text-caption leading-none text-fg-secondary shadow-[inset_0_0_0_1px_var(--border-default),inset_0_-1px_0_var(--border-default)]"
				>{keyGlyph(key)}</span
			>
		{:else}
			<span class="text-label leading-none">{keyGlyph(key)}</span>
		{/if}
	{/each}
</kbd>
