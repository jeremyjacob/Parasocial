<script lang="ts" module>
	export const tooltipClass =
		'z-50 flex h-6 items-center gap-2 rounded-control bg-tooltip px-2 text-ui font-medium text-fg-tooltip shadow-[0_2px_8px_rgb(0_0_0/0.18)] select-none';
</script>

<script lang="ts">
	import { Tooltip } from 'bits-ui';
	import type { Snippet } from 'svelte';
	import { cn, keyGlyph } from '$lib/utils';
	import { usePortalTarget } from '$lib/theme.svelte';

	type Props = {
		/** Tooltip text. Short, sentence case, no period. */
		label: string;
		/** Optional shortcut shown after the label in a quieter tone. */
		shortcut?: string[];
		side?: 'top' | 'right' | 'bottom' | 'left';
		sideOffset?: number;
		/** Force open (docs/screenshots). */
		open?: boolean;
		disabled?: boolean;
		/** The trigger. Spread `props` onto the interactive element. */
		trigger: Snippet<[Record<string, unknown>]>;
		class?: string;
	};

	let {
		label,
		shortcut,
		side = 'top',
		sideOffset = 6,
		open = $bindable(false),
		disabled = false,
		trigger,
		class: className
	}: Props = $props();

	const portalTarget = usePortalTarget();
</script>

<Tooltip.Root bind:open {disabled}>
	<Tooltip.Trigger>
		{#snippet child({ props })}
			{@render trigger(props)}
		{/snippet}
	</Tooltip.Trigger>
	<Tooltip.Portal to={portalTarget()}>
		<Tooltip.Content
			{side}
			{sideOffset}
			collisionPadding={8}
			class={cn(
				'animate-pop', tooltipClass,
				className
			)}
		>
			<span>{label}</span>
			{#if shortcut?.length}
				<span class="flex items-center gap-0.5 text-fg-tooltip/55 tabular">
					{#each shortcut as key, i (i)}<span>{keyGlyph(key)}</span>{/each}
				</span>
			{/if}
			<Tooltip.Arrow class="text-tooltip" width={10} height={5} />
		</Tooltip.Content>
	</Tooltip.Portal>
</Tooltip.Root>
