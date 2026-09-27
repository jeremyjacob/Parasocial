<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';

	type Props = {
		title: string;
		/** Title-row action icons (IconButtons, size sm). */
		actions?: Snippet;
		/** Optional quiet text after the title ("3 overrides"). */
		meta?: string;
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
		heading,
		children,
		class: className,
		bodyClass
	}: Props = $props();
	const uid = $props.id();
</script>

<!--
	Figma UI3 panel section: 40px title row, 16px side padding, hairline divider below.
-->
<section class={cn('border-b border-line-subtle last:border-b-0', className)} aria-labelledby="ps-{uid}">
	<div class="flex h-10 items-center gap-2 pr-2 pl-4">
		{#if heading}
			<div id="ps-{uid}" class="flex min-w-0 items-center">{@render heading()}</div>
		{:else}
			<h3 id="ps-{uid}" class="truncate text-section text-fg">{title}</h3>
		{/if}
		{#if meta}<span class="truncate text-label text-fg-tertiary tabular">{meta}</span>{/if}
		{#if actions}<div class="ml-auto flex shrink-0 items-center gap-0.5">{@render actions()}</div>{/if}
	</div>
	{#if children}
		<div class={cn('flex flex-col gap-2 px-4 pb-4', bodyClass)}>
			{@render children()}
		</div>
	{/if}
</section>
