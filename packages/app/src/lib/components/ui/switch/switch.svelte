<script lang="ts">
	import { Switch, Label } from 'bits-ui';
	import { cn } from '$lib/utils';

	type Props = {
		checked?: boolean;
		disabled?: boolean;
		label?: string;
		class?: string;
		id?: string;
		onCheckedChange?: (v: boolean) => void;
	};
	let { checked = $bindable(false), disabled, label, class: className, id, onCheckedChange }: Props = $props();
	const uid = $props.id();
	const sid = $derived(id ?? `sw-${uid}`);
</script>

<!-- Concentric: track 28×16 radius 8, inset 2 → 12px thumb radius 6. -->
<div class={cn('inline-flex h-7 items-center gap-2', disabled && 'opacity-40', className)}>
	<Switch.Root
		id={sid}
		bind:checked
		{disabled}
		{onCheckedChange}
		class={cn(
			'group/sw inline-flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 focus-ring',
			'bg-line-strong transition-colors duration-[var(--duration-fast)] ease-out data-[state=checked]:bg-accent'
		)}
	>
		<Switch.Thumb
			class="block size-3 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.2)] transition-transform duration-[var(--duration-base)] ease-spring data-[state=checked]:translate-x-3"
		/>
	</Switch.Root>
	{#if label}<Label.Root for={sid} class="truncate whitespace-nowrap text-ui text-fg select-none">{label}</Label.Root>{/if}
</div>
