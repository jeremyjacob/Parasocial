<script lang="ts">
	import { setContext, type Snippet } from 'svelte';
	import { setPortalTarget } from '$lib/theme.svelte';
	import { cn } from '$lib/utils';

	type Props = { theme: 'light' | 'dark'; children: Snippet; class?: string };
	let { theme, children, class: className }: Props = $props();

	// Floating content (tooltips, menus, dialogs) portals into this pane so it inherits the theme.
	let portal: HTMLDivElement | undefined = $state();
	setPortalTarget(() => portal);
	// Sections in the dark pane suffix their ids so anchors stay unique.
	setContext('pane-theme', () => theme);
</script>

<div data-theme={theme} class={cn('relative min-w-0 bg-app text-fg', className)}>
	{@render children()}
	<div bind:this={portal} class="contents"></div>
</div>
