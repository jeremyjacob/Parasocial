<script lang="ts">
	import { cn } from '$lib/utils';

	type Props = {
		color: string;
		/** Accessible name (colour name). Required when interactive. */
		label?: string;
		size?: 12 | 14 | 16 | 20 | 24;
		selected?: boolean;
		/** Render as a button. */
		onclick?: () => void;
		class?: string;
	};
	let { color, label, size = 16, selected = false, onclick, class: className }: Props = $props();
	// Swatches ≥ 20px are pickers (radius 6), small ones sit in rows (radius 4 → 3).
	const radius = $derived(size >= 20 ? 6 : size >= 16 ? 4 : 3);
</script>

{#if onclick}
	<button
		type="button"
		aria-label={label}
		aria-pressed={selected}
		{onclick}
		class={cn(
			'relative shrink-0 focus-ring transition-transform duration-[var(--duration-fast)] ease-out hover:scale-[1.06]',
			selected && 'shadow-[0_0_0_2px_var(--bg-elevated),0_0_0_3.5px_var(--fg-primary)]',
			className
		)}
		style="width:{size}px;height:{size}px;border-radius:{radius}px;background:{color}"
	>
		<span
			class="pointer-events-none absolute inset-0 shadow-[inset_0_0_0_1px_rgb(0_0_0/0.1)]"
			style="border-radius:{radius}px"
		></span>
	</button>
{:else}
	<span
		role={label ? 'img' : undefined}
		aria-label={label}
		class={cn('relative inline-block shrink-0 shadow-[inset_0_0_0_1px_rgb(0_0_0/0.1)]', className)}
		style="width:{size}px;height:{size}px;border-radius:{radius}px;background:{color}"
	></span>
{/if}
