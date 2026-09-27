<script lang="ts">
	import { Slider } from 'bits-ui';
	import { cn } from '$lib/utils';

	type Props = {
		value?: number;
		min?: number;
		max?: number;
		step?: number;
		disabled?: boolean;
		class?: string;
		'aria-label'?: string;
		onValueChange?: (v: number) => void;
		onValueCommit?: (v: number) => void;
	};
	let {
		value = $bindable(0),
		min = 0,
		max = 100,
		step = 1,
		disabled,
		class: className,
		'aria-label': ariaLabel,
		onValueChange,
		onValueCommit
	}: Props = $props();
</script>

<Slider.Root
	type="single"
	bind:value
	{min}
	{max}
	{step}
	{disabled}
	{onValueChange}
	{onValueCommit}
	class={cn(
		'group/sl relative flex h-7 w-full touch-none items-center select-none data-[disabled]:opacity-40',
		className
	)}
>
	<span class="relative h-1 w-full grow overflow-hidden rounded-full bg-active">
		<Slider.Range class="absolute h-full rounded-full bg-accent" />
	</span>
	<Slider.Thumb
		index={0}
		aria-label={ariaLabel}
		class={cn(
			'block size-3.5 rounded-full bg-white shadow-thumb focus-ring',
			'transition-transform duration-[var(--duration-fast)] ease-out hover:scale-110 active:scale-110'
		)}
	/>
</Slider.Root>
