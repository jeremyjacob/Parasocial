<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Eye, EyeOff } from '@lucide/svelte';
	import { cn } from '$lib/utils';
	import { ColorSwatch } from '$lib/components/ui/color-swatch';
	import { StatusBadge, type Status } from '$lib/components/ui/badge';

	type Props = {
		name: string;
		color?: string;
		status?: Status;
		/** Status text shown after the dot, for errors ("didn't regenerate"). */
		statusLabel?: string;
		visible?: boolean;
		selected?: boolean;
		/** Agent currently working on this part: subtle shimmer across the row. */
		busy?: boolean;
		/** Keep hover actions revealed (row has an open menu, or docs). */
		showActions?: boolean;
		/** Leading slot that replaces the swatch (e.g. a file icon in Scripts). */
		leading?: Snippet;
		/** Hover-revealed trailing actions (IconButton size sm). */
		actions?: Snippet;
		/** Always-visible trailing content (e.g. an avatar of the agent editing). */
		trailing?: Snippet;
		onclick?: () => void;
		onVisibleChange?: (v: boolean) => void;
		class?: string;
	};
	let {
		name,
		color,
		status = 'ok',
		statusLabel,
		visible = $bindable(true),
		selected = false,
		busy = false,
		showActions = false,
		leading,
		actions,
		trailing,
		onclick,
		onVisibleChange,
		class: className
	}: Props = $props();

	function toggleVisible(e: MouseEvent) {
		e.stopPropagation();
		visible = !visible;
		onVisibleChange?.(visible);
	}
</script>

<!-- 32px row. Selection in lists is neutral (orange is only for 3D selection). -->
<div
	role="option"
	aria-selected={selected}
	tabindex="0"
	class={cn(
		'group/row relative flex h-8 items-center gap-2 overflow-hidden rounded-control pr-1 pl-2 text-ui select-none',
		'outline-none transition-colors-fast focus-visible:shadow-[inset_0_0_0_1px_var(--border-focus)]',
		selected ? 'bg-active' : 'hover:bg-hover',
		className
	)}
	{onclick}
	onkeydown={(e) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onclick?.();
		}
	}}
>
	{#if busy}
		<span
			aria-hidden="true"
			class="pointer-events-none absolute inset-0 animate-[ps-shimmer_1.8s_linear_infinite] bg-[length:200%_100%] motion-reduce:animate-none"
			style="background-image:linear-gradient(100deg, transparent 30%, var(--accent-subtle) 50%, transparent 70%)"
		></span>
	{/if}
	{#if leading}
		{@render leading()}
	{:else if color}
		<ColorSwatch {color} size={12} class={cn(!visible && 'opacity-40')} />
	{/if}
	<span class={cn('min-w-0 flex-1 truncate', visible ? 'text-fg' : 'text-fg-tertiary', selected && 'font-medium')}
		>{name}</span
	>
	<!--
		Right slot: status/trailing at rest, swapped for actions on hover or focus (same cell, so the
		status never floats mid-row). A hidden part keeps its eye-off visible at all times.
	-->
	<div class="grid shrink-0 items-center justify-items-end [grid-template-areas:'slot']">
		<div
			class={cn(
				'flex h-6 items-center gap-1.5 pr-[9px] [grid-area:slot] transition-opacity duration-[var(--duration-fast)]',
				visible && "group-hover/row:opacity-0 group-focus-within/row:opacity-0",
					visible && showActions && "opacity-0"
			)}
		>
			{#if status !== 'ok'}<StatusBadge {status} label={statusLabel} />{/if}
			{#if trailing}{@render trailing()}{/if}
			{#if !visible}
				<button
					type="button"
					aria-label="Show {name}"
					aria-pressed="true"
					class="-mr-[9px] inline-flex size-6 items-center justify-center rounded-sm text-fg-tertiary transition-colors-fast hover:bg-hover hover:text-fg focus-ring"
					onclick={toggleVisible}><EyeOff /></button
				>
			{/if}
		</div>
		{#if visible}
			<div
				class={cn(
					"flex items-center gap-0.5 opacity-0 [grid-area:slot] transition-opacity duration-[var(--duration-fast)] group-hover/row:opacity-100 group-focus-within/row:opacity-100",
					showActions && "opacity-100"
				)}
			>
				{#if actions}{@render actions()}{/if}
				<button
					type="button"
					aria-label="Hide {name}"
					aria-pressed="false"
					class="inline-flex size-6 items-center justify-center rounded-sm text-fg-tertiary transition-colors-fast hover:bg-hover hover:text-fg focus-ring"
					onclick={toggleVisible}><Eye /></button
				>
			</div>
		{/if}
	</div>
</div>
