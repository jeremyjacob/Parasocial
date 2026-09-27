<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';

	type Props = {
		label: string;
		/** `stacked`: 11px label above the fields (Figma UI3). `inline`: label column on the left (Framer/params). */
		layout?: 'stacked' | 'inline';
		/** Overridden param: accent dot before the label. */
		overridden?: boolean;
		/** Label hover text (e.g. "Default 3 mm · bracket.ts:12"). */
		hint?: string;
		for?: string;
		children: Snippet;
		class?: string;
	};
	let { label, layout = 'stacked', overridden = false, hint, for: htmlFor, children, class: className }: Props =
		$props();
</script>

{#snippet labelEl()}
	<label
		for={htmlFor}
		title={hint}
		class={cn(
			'relative flex min-w-0 items-center text-label text-fg-secondary select-none',
			layout === 'inline' ? 'h-7' : 'h-4'
		)}
	>
		<span aria-hidden="true" class="override-dot" data-on={overridden ? '' : undefined}></span>
		{#if overridden}<span class="sr-only">Overridden: </span>{/if}
		<span class={cn('truncate transition-colors duration-[var(--duration-fast)]', overridden && 'text-fg')}>{label}</span>
	</label>
{/snippet}

{#if layout === 'inline'}
	<div class={cn('grid grid-cols-[84px_minmax(0,1fr)] items-start gap-2', className)}>
		{@render labelEl()}
		<div class="min-w-0">{@render children()}</div>
	</div>
{:else}
	<div class={cn('flex min-w-0 flex-col gap-1.5', className)}>
		{@render labelEl()}
		{@render children()}
	</div>
{/if}
