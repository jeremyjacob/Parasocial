<script lang="ts">
	import { cn } from '$lib/utils';

	type Props = {
		/** `param` → @thickness, `part` → #lid, `entity` → a face/edge stable name. */
		kind: 'param' | 'part' | 'entity';
		name: string;
		/** Part colour (for #part chips). */
		color?: string;
		/** Entity missing / reference didn't resolve. */
		broken?: boolean;
		onclick?: () => void;
		class?: string;
	};
	let { kind, name, color, broken = false, onclick, class: className }: Props = $props();
	const sigil = $derived(kind === 'param' ? '@' : kind === 'part' ? '#' : '');
</script>

<svelte:element
	this={onclick ? 'button' : 'span'}
	type={onclick ? 'button' : undefined}
	role={onclick ? 'button' : undefined}
	{onclick}
	class={cn(
		'inline-flex h-[18px] items-baseline gap-1 rounded-sm px-1 align-baseline text-[0.95em] leading-[18px] font-medium whitespace-nowrap',
		broken
			? 'bg-error-subtle text-error line-through decoration-error/50'
			: kind === 'entity'
				? 'bg-active font-mono text-[0.88em] text-fg'
				: 'bg-accent-subtle text-accent-fg',
		onclick && 'cursor-default hover:brightness-95 focus-ring',
		className
	)}
>
	{#if kind === 'part' && color}
		<span class="size-2 self-center rounded-[2px]" style="background:{color}"></span>
	{/if}
	<span>{sigil}{name}</span>
</svelte:element>
