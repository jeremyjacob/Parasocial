<script lang="ts">
	import type { Snippet } from 'svelte';
	import { ChevronRight } from '@lucide/svelte';
	import { cn } from '$lib/utils';
	import { reveal } from '$lib/styles/motion';

	type Props = {
		title: string;
		/** Title-row action icons (IconButtons, size sm). */
		actions?: Snippet;
		/** Optional quiet text after the title ("3 overrides"). */
		meta?: string;
		/** Collapsible sections get a disclosure chevron (param groups per part). */
		collapsible?: boolean;
		open?: boolean;
		/** Replace the title text with custom content (e.g. a ghost Select: "Frame ▾"). */
		heading?: Snippet;
		children?: Snippet;
		class?: string;
		/** Classes for the body (e.g. `gap-1` for dense 28px property rows → 32px pitch). */
		bodyClass?: string;
	};
	let {
		title,
		actions,
		meta,
		collapsible = false,
		open = $bindable(true),
		heading,
		children,
		class: className,
		bodyClass
	}: Props = $props();
	const uid = $props.id();
</script>

<!--
	Figma UI3 panel section: 40px title row, 16px side padding, hairline divider below.
	A collapsible title hangs its chevron in the 16px gutter so the title text stays on the same
	left edge as plain section titles and the rows below.
-->
<section class={cn('border-b border-line-subtle last:border-b-0', className)} aria-labelledby="ps-{uid}">
	<div class="flex h-10 items-center gap-1 pr-2 pl-4">
		{#if collapsible}
			<button
				type="button"
				id="ps-{uid}"
				aria-expanded={open}
				class="-ml-4 flex h-7 min-w-0 items-center rounded-control pr-1.5 pl-0.5 text-ui font-semibold text-fg transition-colors-fast focus-ring hover:bg-hover"
				onclick={() => (open = !open)}
			>
				<ChevronRight
					size={14}
					class={cn(
						'shrink-0 text-fg-tertiary transition-transform duration-[var(--duration-base)] ease-out',
						open && 'rotate-90'
					)}
				/>
				<span class="truncate">{title}</span>
			</button>
		{:else if heading}
			<div id="ps-{uid}" class="flex min-w-0 items-center">{@render heading()}</div>
		{:else}
			<h3 id="ps-{uid}" class="truncate text-ui font-semibold text-fg">{title}</h3>
		{/if}
		{#if meta}<span class="truncate text-label text-fg-tertiary tabular">{meta}</span>{/if}
		{#if actions}<div class="ml-auto flex shrink-0 items-center gap-0.5">{@render actions()}</div>{/if}
	</div>
	{#if children && open}
		<div
			class={cn('flex flex-col gap-2 px-4 pb-4', bodyClass)}
			transition:reveal
		>
			{@render children()}
		</div>
	{/if}
</section>
