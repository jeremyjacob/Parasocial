<script lang="ts" module>
	import type { Component } from 'svelte';

	export type ToggleGroupItem = {
		value: string;
		label: string;
		icon: Component<{ size?: number; strokeWidth?: number }>;
		shortcut?: string[];
		disabled?: boolean;
	};
</script>

<script lang="ts">
	import { ToggleGroup } from 'bits-ui';
	import { cn } from '$lib/utils';
	import { Tooltip } from '$lib/components/ui/tooltip';
	import { mergeProps } from 'svelte-toolbelt';

	type Props = {
		/** Multiple independent toggles (e.g. selection filters). */
		value?: string[];
		items: ToggleGroupItem[];
		size?: 'sm' | 'md';
		disabled?: boolean;
		class?: string;
		'aria-label'?: string;
		onValueChange?: (v: string[]) => void;
	};
	let {
		value = $bindable([]),
		items,
		size = 'md',
		disabled,
		class: className,
		'aria-label': ariaLabel,
		onValueChange
	}: Props = $props();
</script>

<ToggleGroup.Root
	type="multiple"
	bind:value
	{disabled}
	{onValueChange}
	aria-label={ariaLabel}
	class={cn('inline-flex items-center gap-0.5', className)}
>
	{#each items as item (item.value)}
		<Tooltip label={item.label} shortcut={item.shortcut}>
			{#snippet trigger(tprops)}
				<ToggleGroup.Item value={item.value} disabled={item.disabled}>
					{#snippet child({ props })}
						<button
							{...mergeProps(tprops, props)}
							aria-label={item.label}
							class={cn(
								'inline-flex items-center justify-center rounded-control text-fg-secondary select-none focus-ring transition-colors-fast',
								'hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40',
								'data-[state=on]:bg-accent-subtle data-[state=on]:text-accent-fg',
								size === 'sm' ? 'size-6' : 'size-7'
							)}
						>
							<item.icon size={16} strokeWidth={1.5} />
						</button>
					{/snippet}
				</ToggleGroup.Item>
			{/snippet}
		</Tooltip>
	{/each}
</ToggleGroup.Root>
