<script lang="ts">
	import { flip } from 'svelte/animate';
	import { rise, flipDuration, easeOut } from '$lib/styles/motion';
	import { toasts } from './toast.svelte';
	import ToastItem from './toast-item.svelte';

	/** Distance from the bottom edge; sits above the floating viewport toolbar. */
	let { offset = 76 }: { offset?: number } = $props();
</script>

<!-- Toasts rise out of the toolbar area with a slight scale, and drop away faster than they came. -->
<div
	class="pointer-events-none fixed inset-x-0 z-[60] flex flex-col items-center gap-2"
	style="bottom: {offset}px"
	aria-live="polite"
>
	{#each toasts.items as t (t.id)}
		<div
			animate:flip={{ duration: flipDuration(), easing: easeOut }}
			in:rise={{ y: 10, scale: 0.96, duration: 200, origin: '50% 100%' }}
			out:rise={{ y: 4, scale: 0.98, duration: 120 }}
		>
			<ToastItem toast={t} ondismiss={() => toasts.dismiss(t.id)} />
		</div>
	{/each}
</div>
