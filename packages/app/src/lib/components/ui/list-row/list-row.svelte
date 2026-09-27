<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Eye, EyeOff } from '@lucide/svelte';
	import { cn } from '$lib/utils';
	import { ColorSwatch } from '$lib/components/ui/color-swatch';
	import { StatusBadge, type Status } from '$lib/components/ui/badge';
	import { Tooltip } from '$lib/components/ui/tooltip';
	import IsolateIcon from './isolate-icon.svelte';

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
		/** Isolate toggle (shown only when `onIsolateChange` is set). */
		isolated?: boolean;
		onIsolateChange?: (v: boolean) => void;
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
		isolated = false,
		onIsolateChange,
		class: className
	}: Props = $props();

	function toggleVisible(e: MouseEvent) {
		e.stopPropagation();
		visible = !visible;
		onVisibleChange?.(visible);
	}

	function toggleIsolate(e: MouseEvent) {
		e.stopPropagation();
		onIsolateChange?.(!isolated);
	}

	const toggleClass =
		'inline-flex size-6 items-center justify-center rounded-sm text-fg-tertiary transition-colors-fast hover:bg-hover hover:text-fg focus-ring aria-pressed:text-fg-secondary';
	/** Toggles with a set state stay visible at rest (hidden, isolated). */
	const pinned = $derived(!visible || isolated);
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
	<!-- Fixed 16px leading cell so swatches and file icons share one text column. -->
	{#if leading || color}
		<span class="flex w-4 shrink-0 items-center justify-center">
			{#if leading}
				{@render leading()}
			{:else if color}
				<ColorSwatch {color} size={12} class={cn(!visible && 'opacity-40')} />
			{/if}
		</span>
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
				'flex h-6 items-center gap-1.5 [grid-area:slot] transition-opacity duration-[var(--duration-fast)]',
				!pinned && 'pr-[9px]',
				!pinned && 'group-hover/row:opacity-0 group-focus-within/row:opacity-0',
				!pinned && showActions && 'opacity-0',
				pinned && 'invisible group-hover/row:invisible'
			)}
		>
			{#if status !== 'ok'}<StatusBadge {status} label={statusLabel} />{/if}
			{#if trailing}{@render trailing()}{/if}
		</div>
		<div
			class={cn(
				'flex items-center gap-0.5 [grid-area:slot] transition-opacity duration-[var(--duration-fast)]',
				pinned || showActions ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100'
			)}
		>
			{#if actions}<span class={cn('flex items-center gap-0.5', pinned && 'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100')}>{@render actions()}</span>{/if}
			{#if onIsolateChange}
				<Tooltip label={isolated ? 'Show all parts' : 'Isolate'}>
					{#snippet trigger(tp)}
						<button
							{...tp}
							type="button"
							aria-label={isolated ? 'Show all parts' : `Isolate ${name}`}
							aria-pressed={isolated}
							class={cn(toggleClass, pinned && !isolated && 'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100')}
							onclick={toggleIsolate}><IsolateIcon on={isolated} /></button
						>
					{/snippet}
				</Tooltip>
			{/if}
			<Tooltip label={visible ? 'Hide' : 'Show'}>
				{#snippet trigger(tp)}
					<button
						{...tp}
						type="button"
						aria-label="{visible ? 'Hide' : 'Show'} {name}"
						aria-pressed={!visible}
						class={cn(toggleClass, pinned && visible && 'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100')}
						onclick={toggleVisible}>{#if visible}<Eye />{:else}<EyeOff />{/if}</button
					>
				{/snippet}
			</Tooltip>
		</div>
	</div>
</div>
