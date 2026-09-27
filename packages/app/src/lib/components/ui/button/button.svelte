<script lang="ts" module>
	import { tv, type VariantProps } from 'tailwind-variants';

	export const buttonVariants = tv({
		base: [
			'relative inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap select-none',
			'font-medium focus-ring transition-colors-fast',
			'disabled:pointer-events-none disabled:opacity-40 aria-disabled:pointer-events-none aria-disabled:opacity-40',
			'[&_svg]:shrink-0'
		],
		variants: {
			variant: {
				primary:
					'bg-accent text-fg-on-accent shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_1px_2px_rgb(0_0_0/0.12)] hover:bg-accent-hover',
				secondary: 'bg-control text-fg shadow-control hover:bg-control-hover',
				ghost: 'text-fg hover:bg-hover active:bg-active data-[state=open]:bg-active',
				destructive:
					'bg-error text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_1px_2px_rgb(0_0_0/0.12)] hover:brightness-[0.94]'
			},
			size: {
				sm: 'h-6 rounded-control px-2 text-ui',
				md: 'h-7 rounded-control px-3 text-ui',
				lg: 'h-8 rounded-md px-3.5 text-ui'
			}
		},
		defaultVariants: { variant: 'secondary', size: 'md' }
	});

	export type ButtonVariant = VariantProps<typeof buttonVariants>['variant'];
	export type ButtonSize = VariantProps<typeof buttonVariants>['size'];
</script>

<script lang="ts">
	import type { HTMLButtonAttributes, HTMLAnchorAttributes } from 'svelte/elements';
	import { LoaderCircle } from '@lucide/svelte';
	import { cn } from '$lib/utils';

	type Props = HTMLButtonAttributes &
		Pick<HTMLAnchorAttributes, 'href'> & {
			variant?: ButtonVariant;
			size?: ButtonSize;
			loading?: boolean;
			ref?: HTMLElement | null;
		};

	let {
		variant = 'secondary',
		size = 'md',
		loading = false,
		href,
		type = 'button',
		disabled,
		class: className,
		ref = $bindable(null),
		children,
		...rest
	}: Props = $props();
</script>

{#if href}
	<a
		bind:this={ref}
		{href}
		class={cn(buttonVariants({ variant, size }), className)}
		aria-disabled={disabled || undefined}
		{...rest as HTMLAnchorAttributes}
	>
		{@render children?.()}
	</a>
{:else}
	<button
		bind:this={ref}
		{type}
		class={cn(buttonVariants({ variant, size }), className)}
		disabled={disabled || loading}
		aria-busy={loading || undefined}
		{...rest}
	>
		{#if loading}
			<LoaderCircle size={14} strokeWidth={1.75} class="animate-[ps-spin_0.8s_linear_infinite]" />
		{/if}
		{@render children?.()}
	</button>
{/if}
