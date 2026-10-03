<script lang="ts" module>
	/**
	 * Drag-to-toggle (After Effects style): pressing an eye starts a paint with the state that press
	 * set, and every row the pointer drags across takes that same state until release.
	 */
	let paint = $state<boolean | null>(null);
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Eye, EyeOff } from '@lucide/svelte';
	import { cn } from '$lib/utils';
	import { ColorSwatch } from '$lib/components/ui/color-swatch';
	import { StatusBadge, type Status } from '$lib/components/ui/badge';

	type Props = {
		name: string;
		/** One line saying more (a studio's `description` export), shown with the name on hover. */
		description?: string;
		color?: string;
		status?: Status;
		/** Status text shown after the dot, for errors ("didn't regenerate"). */
		statusLabel?: string;
		visible?: boolean;
		/** Show the eye toggle (default); off for rows that can't be hidden on their own. */
		hideable?: boolean;
		/** Hidden by its parent row: greyed, but the eye-off only shows on hover (the parent carries it). */
		parentHidden?: boolean;
		selected?: boolean;
		/** Bold name without the selected background (e.g. a group whose children are selected). */
		strong?: boolean;
		/** Greyed out like a hidden row, without pinning the eye (e.g. a studio not in the viewport). */
		dimmed?: boolean;
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
		onclick?: (event: MouseEvent) => void;
		onVisibleChange?: (v: boolean) => void;
		class?: string;
	};
	let {
		name,
		description,
		color,
		status = 'ok',
		statusLabel,
		visible = $bindable(true),
		hideable = true,
		parentHidden = false,
		selected = false,
		strong = false,
		dimmed = false,
		busy = false,
		showActions = false,
		leading,
		actions,
		trailing,
		onclick,
		onVisibleChange,
		class: className
	}: Props = $props();

	function setVisible(v: boolean) {
		if (v === visible) return;
		visible = v;
		onVisibleChange?.(v);
	}

	function startPaint(e: PointerEvent) {
		e.stopPropagation();
		if (e.button !== 0) return;
		e.preventDefault();
		// touch captures the pointer to the pressed element; release so other rows get pointerenter
		(e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
		paint = !visible;
		setVisible(paint);
		const end = () => {
			paint = null;
			removeEventListener('pointerup', end);
			removeEventListener('pointercancel', end);
		};
		addEventListener('pointerup', end);
		addEventListener('pointercancel', end);
	}

	function paintOver() {
		if (paint !== null && hideable) setVisible(paint);
	}

	const toggleClass =
		'inline-flex size-6 items-center justify-center rounded-sm text-fg-tertiary hover:text-fg focus-ring aria-pressed:text-fg-secondary';
	/** Toggles with a set state stay visible at rest (hidden). */
	const pinned = $derived(hideable && !visible && !parentHidden);
</script>

<!-- 28px row. List selection is a blue tint (orange is only for 3D selection). -->
<!-- The name button carries keyboard access; the row itself is a larger mouse target that selects on press. -->
<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div
	class={cn(
		'group/row relative flex h-7 items-center gap-2 overflow-hidden rounded-control pr-1 pl-1.5 text-ui select-none',
		'outline-none has-[.row-main:focus-visible]:shadow-[inset_0_0_0_1px_var(--border-focus)]',
		selected ? 'bg-accent-subtle' : 'hover:bg-hover',
		className
	)}
	onpointerdown={(e) => e.button === 0 && onclick?.(e)}
	onclick={(e) => e.detail === 0 && onclick?.(e)}
	onpointerenter={paintOver}
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
				<ColorSwatch color={dimmed ? 'var(--fg-disabled)' : color} size={12} class={cn(!visible && 'opacity-30', dimmed && "opacity-75")} />
			{/if}
		</span>
	{/if}
	<button
		type="button"
		class={cn('row-main min-w-0 flex-1 truncate text-left outline-none', !visible ? 'text-fg-tertiary/60' : dimmed ? 'text-fg-secondary' : 'text-fg', (selected || strong) && 'font-medium')}
		title={description ? `${name}\n${description}` : undefined}
		aria-current={selected ? 'true' : undefined}>{name}</button
	>
	<!--
		Right slot: status/trailing at rest, swapped for actions on hover or focus (same cell, so the
		status never floats mid-row). A hidden part keeps its eye-off visible at all times.
	-->
	<div class="grid shrink-0 items-center justify-items-end [grid-template-areas:'slot']">
		<div
			class={cn(
				'flex h-6 items-center gap-1.5 [grid-area:slot]',
				!pinned && 'pr-[9px]',
				!pinned && 'group-hover/row:opacity-0 group-has-[:focus-visible]/row:opacity-0',
				!pinned && showActions && 'opacity-0',
				pinned && 'invisible group-hover/row:invisible'
			)}
		>
			{#if status !== 'ok'}<StatusBadge {status} label={statusLabel} />{/if}
			{#if trailing}{@render trailing()}{/if}
		</div>
		<div
			class={cn(
				'flex items-center gap-0.5 [grid-area:slot]',
				pinned || showActions ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100 group-has-[:focus-visible]/row:opacity-100'
			)}
		>
			{#if actions}<!-- svelte-ignore a11y_no_static_element_interactions --><span onpointerdown={(e) => e.stopPropagation()} class={cn('flex items-center gap-0.5', pinned && 'opacity-0 group-hover/row:opacity-100 group-has-[:focus-visible]/row:opacity-100')}>{@render actions()}</span>{/if}
			{#if hideable}
				<button
					type="button"
					aria-label="{visible ? 'Hide' : 'Show'} {name}"
					aria-pressed={!visible}
					class={cn(toggleClass, 'touch-none', pinned && visible && 'opacity-0 group-hover/row:opacity-100 group-has-[:focus-visible]/row:opacity-100')}
					onpointerdown={startPaint}
					onclick={(e) => {
						e.stopPropagation();
						// pointer presses toggle on pointerdown; only keyboard activation lands here
						if (e.detail === 0) setVisible(!visible);
					}}>{#if visible}<Eye />{:else}<EyeOff />{/if}</button
				>
			{/if}
		</div>
	</div>
</div>
