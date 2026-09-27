<script lang="ts">
	import { getContext, type Snippet } from 'svelte';
	type Props = { id: string; title: string; description?: string; children: Snippet };
	let { id, title, description, children }: Props = $props();
	const paneTheme = getContext<(() => string) | undefined>('pane-theme');
	const domId = $derived(paneTheme?.() === 'dark' ? `${id}-dark` : id);
</script>

<section id={domId} data-section={id} class="flex scroll-mt-16 flex-col gap-4 px-8 py-8">
	<header class="flex flex-col gap-1">
		<h2 class="text-heading text-fg">{title}</h2>
		{#if description}<p class="max-w-[560px] text-body text-fg-secondary">{description}</p>{/if}
	</header>
	{@render children()}
</section>
