<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';
	import { Kbd } from '$lib/components/ui/kbd';
	import ClayArt from './clay-art.svelte';

	type Props = {
		title: string;
		description?: string;
		/** Image URL (clay render). Falls back to the built-in geometric placeholder. */
		image?: string;
		imageAlt?: string;
		/** Compact = inside a panel (no image by default, smaller type). */
		size?: 'panel' | 'page';
		action?: Snippet;
		shortcut?: { keys: string[]; label: string };
		class?: string;
	};
	let {
		title,
		description,
		image,
		imageAlt = '',
		size = 'page',
		action,
		shortcut,
		class: className
	}: Props = $props();
</script>

<div
	class={cn(
		'flex flex-col items-center text-center',
		size === 'page' ? 'gap-4 px-6 py-8' : 'gap-3 px-4 py-6',
		className
	)}
>
	{#if image}
		<img src={image} alt={imageAlt} class={size === 'page' ? 'h-36 w-auto' : 'h-20 w-auto'} />
	{:else}
		<ClayArt size={size === 'page' ? 144 : 72} />
	{/if}
	<div class="flex max-w-[280px] flex-col gap-1">
		<h3 class={cn('font-semibold text-fg', size === 'page' ? 'text-title' : 'text-ui')}>{title}</h3>
		{#if description}<p class="text-ui text-fg-secondary">{description}</p>{/if}
	</div>
	{#if action || shortcut}
		<div class="flex flex-col items-center gap-2.5">
			{#if action}{@render action()}{/if}
			{#if shortcut}
				<span class="flex items-center gap-1.5 text-label text-fg-tertiary">
					<Kbd keys={shortcut.keys} />{shortcut.label}
				</span>
			{/if}
		</div>
	{/if}
</div>
