<script lang="ts" module>
	import { tv } from 'tailwind-variants';

	export const iconButtonVariants = tv({
		base: [
			'relative inline-flex shrink-0 items-center justify-center select-none focus-ring transition-colors-fast',
			'text-fg-secondary hover:text-fg',
			'disabled:pointer-events-none disabled:opacity-40'
		],
		variants: {
			variant: {
				ghost: 'hover:bg-hover active:bg-active data-[state=open]:bg-active data-[state=open]:text-fg',
				secondary: 'bg-control text-fg shadow-control hover:bg-control-hover',
				accent: 'bg-accent-subtle text-accent-fg hover:bg-accent-subtle'
			},
			size: {
				sm: 'size-6 rounded-control',
				md: 'size-7 rounded-control',
				lg: 'size-8 rounded-md'
			},
			active: {
				true: 'bg-active text-fg hover:bg-active'
			}
		},
		compoundVariants: [
			{ variant: 'accent', active: true, class: 'bg-accent text-fg-on-accent hover:bg-accent-hover hover:text-fg-on-accent' }
		],
		defaultVariants: { variant: 'ghost', size: 'md' }
	});
</script>

<script lang="ts">
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';
	import { mergeProps } from "svelte-toolbelt";
	import { Tooltip } from '$lib/components/ui/tooltip';

	type Props = Omit<HTMLButtonAttributes, 'children'> & {
		/** Accessible name; also the tooltip text. */
		label: string;
		shortcut?: string[];
		/** Show a tooltip on hover/focus (default true). */
		tooltip?: boolean;
		tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
		variant?: 'ghost' | 'secondary' | 'accent';
		size?: 'sm' | 'md' | 'lg';
		/** Pressed/selected state (toolbar tools, toggles). Sets aria-pressed. */
		active?: boolean;
		children: Snippet;
	};

	let {
		label,
		shortcut,
		tooltip = true,
		tooltipSide = 'top',
		variant = 'ghost',
		size = 'md',
		active,
		class: className,
		children,
		...rest
	}: Props = $props();
</script>

{#snippet button(extra: Record<string, unknown> = {})}
	<button
		type="button"
		aria-label={label}
		aria-pressed={active === undefined ? undefined : active}
		class={cn(iconButtonVariants({ variant, size, active: !!active }), className)}
		{...mergeProps(extra, rest)}
	>
		{@render children()}
	</button>
{/snippet}

{#if tooltip}
	<Tooltip {label} {shortcut} side={tooltipSide}>
		{#snippet trigger(props)}
			{@render button(props)}
		{/snippet}
	</Tooltip>
{:else}
	{@render button()}
{/if}
