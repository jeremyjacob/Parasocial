<script lang="ts">
	import { History, ArrowRight } from '@lucide/svelte';
	import { cn } from '$lib/utils';

	type Props = {
		version: number;
		/** "14:02" or "2 min ago". */
		time?: string;
		/** Change summary ("thickness 3 → 4"). */
		summary?: string;
		/** Opens Compare. */
		onclick?: () => void;
		class?: string;
	};
	let { version, time, summary, onclick, class: className }: Props = $props();
</script>

<button
	type="button"
	{onclick}
	class={cn(
		'group/vc inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-control bg-control pr-2 pl-2 text-left text-label text-fg shadow-control transition-colors-fast hover:bg-control-hover focus-ring',
		className
	)}
>
	<History size={12} strokeWidth={1.75} class="shrink-0 text-fg-tertiary" />
	<span class="shrink-0 font-semibold tabular">v{version}</span>
	{#if time}<span class="shrink-0 whitespace-nowrap text-fg-tertiary tabular">{time}</span>{/if}
	{#if summary}<span class="min-w-0 flex-1 truncate text-fg-secondary" title={summary}>{summary}</span>{/if}
	<span class="ml-auto flex shrink-0 items-center gap-0.5 pl-1 font-medium whitespace-nowrap text-accent-fg">
		Compare<ArrowRight size={12} strokeWidth={1.75} class="transition-transform duration-[var(--duration-fast)] group-hover/vc:translate-x-0.5" />
	</span>
</button>
