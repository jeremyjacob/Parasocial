<script lang="ts">
	import { Toggle } from 'bits-ui';
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';
	import { Tooltip } from '$lib/components/ui/tooltip';
	import { mergeProps } from 'svelte-toolbelt';

	type Props = {
		pressed?: boolean;
		label: string;
		shortcut?: string[];
		disabled?: boolean;
		size?: 'sm' | 'md';
		/** Show text next to the icon instead of an icon-only square. */
		text?: string;
		class?: string;
		children: Snippet;
		onPressedChange?: (v: boolean) => void;
	};
	let {
		pressed = $bindable(false),
		label,
		shortcut,
		disabled,
		size = 'md',
		text,
		class: className,
		children,
		onPressedChange
	}: Props = $props();
</script>

<Tooltip {label} {shortcut}>
	{#snippet trigger(tprops)}
		<Toggle.Root bind:pressed {disabled} {onPressedChange}>
			{#snippet child({ props })}
				<button
					{...mergeProps(tprops, props)}
					aria-label={text ? undefined : label}
					class={cn(
						'inline-flex items-center justify-center gap-1.5 rounded-control text-fg-secondary select-none focus-ring transition-colors-fast',
						'hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40',
						'data-[state=on]:bg-accent-subtle data-[state=on]:text-accent-fg',
						size === 'sm' ? 'h-6 min-w-6' : 'h-7 min-w-7',
						text && 'px-2 text-ui font-medium',
						className
					)}
				>
					{@render children()}
					{#if text}<span>{text}</span>{/if}
				</button>
			{/snippet}
		</Toggle.Root>
	{/snippet}
</Tooltip>
