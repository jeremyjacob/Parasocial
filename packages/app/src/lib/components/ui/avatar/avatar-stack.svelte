<script lang="ts">
	import { cn } from '$lib/utils';
	import Avatar, { type Person } from './avatar.svelte';

	type Props = {
		people: Person[];
		max?: number;
		size?: 20 | 24 | 28;
		class?: string;
	};
	let { people, max = 3, size = 24, class: className }: Props = $props();
	const shown = $derived(people.slice(0, max));
	const extra = $derived(people.length - shown.length);
</script>

<!-- Overlapping stack (Framer top bar). Each avatar gets a surface-coloured ring to separate it. -->
<span class={cn('inline-flex items-center', className)}>
	{#each shown as p, i (p.name)}
		<Avatar {...p} {size} ring class={i > 0 ? '-ml-1.5' : ''} />
	{/each}
	{#if extra > 0}
		<span
			class="-ml-1.5 inline-flex items-center justify-center rounded-full bg-active px-1.5 text-label font-medium text-fg-secondary tabular shadow-[0_0_0_1.5px_var(--bg-panel)]"
			style="height:{size}px;min-width:{size}px">+{extra}</span
		>
	{/if}
</span>
