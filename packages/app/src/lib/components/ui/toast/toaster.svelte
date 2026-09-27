<script lang="ts">
	import { fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { flip } from 'svelte/animate';
	import { prefersReducedMotion } from '$lib/styles/tokens';
	import { toasts } from './toast.svelte';
	import ToastItem from './toast-item.svelte';

	/** Distance from the bottom edge; sits above the floating viewport toolbar. */
	let { offset = 76 }: { offset?: number } = $props();
	const dur = () => (prefersReducedMotion() ? 0 : 200);
</script>

<div
	class="pointer-events-none fixed inset-x-0 z-[60] flex flex-col items-center gap-2"
	style="bottom: {offset}px"
	aria-live="polite"
>
	{#each toasts.items as t (t.id)}
		<div
			animate:flip={{ duration: dur() }}
			in:fly={{ y: 8, duration: dur(), easing: cubicOut }}
			out:fly={{ y: 4, duration: dur() * 0.75, easing: cubicOut }}
		>
			<ToastItem toast={t} ondismiss={() => toasts.dismiss(t.id)} />
		</div>
	{/each}
</div>
