<script lang="ts">
	import { cn } from '$lib/utils';

	type Props = {
		/** 0–1 for determinate progress; omit for an indeterminate sweep. */
		value?: number;
		/** Fades out when false (keeps layout; it's absolutely positioned by the parent). */
		active?: boolean;
		label?: string;
		class?: string;
	};
	let { value, active = true, label = 'Loading', class: className }: Props = $props();
</script>

<!-- 2px line along the top edge of its container (engine loading, regeneration). -->
<div
	role="progressbar"
	aria-label={label}
	aria-valuemin={0}
	aria-valuemax={100}
	aria-valuenow={value === undefined ? undefined : Math.round(value * 100)}
	aria-hidden={!active}
	class={cn(
		'h-0.5 w-full overflow-hidden transition-opacity duration-[var(--duration-slow)]',
		active ? 'opacity-100' : 'opacity-0',
		className
	)}
>
	{#if value === undefined}
		<div
			class="h-full w-1/2 origin-left animate-[ps-progress_1.4s_var(--ease-in-out)_infinite] motion-reduce:animate-none rounded-full bg-accent"
			style:animation-play-state={active ? 'running' : 'paused'}
		></div>
	{:else}
		<div
			class="h-full origin-left bg-accent transition-transform duration-[var(--duration-base)] ease-out"
			style="transform:scaleX({Math.max(0, Math.min(1, value))})"
		></div>
	{/if}
</div>
