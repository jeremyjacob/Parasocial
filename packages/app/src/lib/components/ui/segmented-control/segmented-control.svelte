<script lang="ts" module>
	import type { LucideIcon } from '@lucide/svelte';

	export type SegmentedItem = {
		value: string;
		/** Visible text. Omit for icon-only segments (then `label` is required for a11y). */
		text?: string;
		label?: string;
		icon?: LucideIcon;
		disabled?: boolean;
	};
</script>

<script lang="ts">
	import { ToggleGroup } from 'bits-ui';
	import { cn } from '$lib/utils';
	import { Tooltip } from '$lib/components/ui/tooltip';
	import { mergeProps } from 'svelte-toolbelt';

	type Props = {
		value?: string;
		items: SegmentedItem[];
		size?: 'sm' | 'md';
		disabled?: boolean;
		/** Stretch to the container width (segments share it equally). */
		fill?: boolean;
		class?: string;
		'aria-label'?: string;
		onValueChange?: (v: string) => void;
	};
	let {
		value = $bindable(''),
		items,
		size = 'md',
		disabled,
		fill = false,
		class: className,
		'aria-label': ariaLabel,
		onValueChange
	}: Props = $props();

	const index = $derived(Math.max(0, items.findIndex((i) => i.value === value)));

	// Figma-style: a segmented control always has exactly one value; ignore deselection.
	function change(v: string) {
		if (!v) return;
		value = v;
		onValueChange?.(v);
	}
</script>

<!--
	Concentric: track radius 6, padding 2 → thumb/segment radius 4.
	The thumb is a single element that slides (spring ease), segments are equal width.
-->
<ToggleGroup.Root
	type="single"
	{value}
	onValueChange={change}
	{disabled}
	aria-label={ariaLabel}
	class={cn(
		'relative isolate grid auto-cols-fr grid-flow-col rounded-[var(--segment-radius)] bg-input p-[var(--segment-pad)]',
		size === 'sm' ? 'h-6' : 'h-7',
		fill ? 'w-full' : 'w-fit',
		disabled && 'opacity-40',
		className
	)}
	style="--count: {items.length}"
>
	<span
		aria-hidden="true"
		class="absolute top-[var(--segment-pad)] bottom-[var(--segment-pad)] left-[var(--segment-pad)] -z-10 rounded-[var(--segment-item-radius)] bg-control shadow-thumb transition-transform duration-[var(--duration-base)] ease-spring"
		style="width: calc((100% - 2 * var(--segment-pad)) / var(--count)); transform: translateX({index * 100}%)"
	></span>
	{#each items as item (item.value)}
		{#snippet seg(extra: Record<string, unknown>)}
			<ToggleGroup.Item value={item.value} disabled={item.disabled}>
				{#snippet child({ props })}
					<button
						{...mergeProps(extra, props)}
						aria-label={item.text ? undefined : item.label}
						class={cn(
							'inline-flex min-w-0 items-center justify-center gap-1.5 rounded-[var(--segment-item-radius)] text-ui font-medium text-fg-secondary select-none focus-ring transition-colors-fast',
							'hover:text-fg data-[state=on]:text-fg disabled:opacity-40',
							item.text ? 'px-2.5' : size === 'sm' ? 'px-1.5' : 'px-2'
						)}
					>
						{#if item.icon}<item.icon />{/if}
						{#if item.text}<span class="truncate">{item.text}</span>{/if}
					</button>
				{/snippet}
			</ToggleGroup.Item>
		{/snippet}
		{#if !item.text && item.label}
			<Tooltip label={item.label}>
				{#snippet trigger(p)}{@render seg(p)}{/snippet}
			</Tooltip>
		{:else}
			{@render seg({})}
		{/if}
	{/each}
</ToggleGroup.Root>
