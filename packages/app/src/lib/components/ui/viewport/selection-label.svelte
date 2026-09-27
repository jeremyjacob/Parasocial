<script lang="ts">
	import { cn } from '$lib/utils';

	type Props = {
		/** Pre-formatted value ("175.2", "Ø 6", "3 faces"). */
		value: string;
		unit?: string;
		class?: string;
		style?: string;
	};
	let { value, unit, class: className, style }: Props = $props();
</script>

<!--
	Figma's size label, in selection orange (it belongs to the selection, so it takes its colour).
	Anchored by the viewer next to the selection; this component is only the pill.
-->
<output
	{style}
	class={cn(
		'pointer-events-none inline-flex h-5 items-center gap-[3px] rounded-sm bg-selected px-1.5 text-label font-semibold whitespace-nowrap text-white tabular shadow-[0_1px_2px_rgb(0_0_0/0.15)]',
		className
	)}
>
	<span>{value}</span>
	{#if unit}<span class="font-medium opacity-85">{unit}</span>{/if}
</output>
