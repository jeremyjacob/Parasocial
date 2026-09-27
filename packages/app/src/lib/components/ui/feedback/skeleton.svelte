<script lang="ts">
	import { cn } from '$lib/utils';
	let { class: className, style }: { class?: string; style?: string } = $props();
</script>

<div
	aria-hidden="true"
	class={cn(
		'rounded-sm bg-active bg-[length:200%_100%] animate-[ps-shimmer_1.6s_linear_infinite] motion-reduce:animate-none',
		className
	)}
	style="background-image:linear-gradient(90deg, transparent 30%, var(--bg-hover) 50%, transparent 70%);{style ?? ''}"
></div>
