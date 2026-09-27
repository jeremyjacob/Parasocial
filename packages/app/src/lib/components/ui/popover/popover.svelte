<script lang="ts">
	import { Popover } from 'bits-ui';
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';
	import { usePortalTarget } from '$lib/theme.svelte';

	type Props = {
		open?: boolean;
		side?: 'top' | 'right' | 'bottom' | 'left';
		align?: 'start' | 'center' | 'end';
		sideOffset?: number;
		/** Spread `props` onto the trigger element. */
		trigger: Snippet<[Record<string, unknown>]>;
		children: Snippet;
		/** Optional header title (Figma-style popover panel with a title row). */
		title?: string;
		class?: string;
	};
	let {
		open = $bindable(false),
		side = 'bottom',
		align = 'center',
		sideOffset = 6,
		trigger,
		children,
		title,
		class: className
	}: Props = $props();
	const portalTarget = usePortalTarget();
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}{@render trigger(props)}{/snippet}
	</Popover.Trigger>
	<Popover.Portal to={portalTarget()}>
		<Popover.Content
			{side}
			{align}
			{sideOffset}
			collisionPadding={8}
			class={cn(
				'animate-pop z-50 w-64 rounded-panel bg-elevated text-ui text-fg shadow-popover outline-none',
				className
			)}
		>
			{#if title}
				<div class="flex h-10 items-center border-b border-line-subtle px-3 font-semibold">{title}</div>
			{/if}
			<div class="p-3">{@render children()}</div>
		</Popover.Content>
	</Popover.Portal>
</Popover.Root>
