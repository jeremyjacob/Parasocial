<script lang="ts">
	import { CircleCheck, CircleAlert, LoaderCircle, X } from '@lucide/svelte';
	import { cn } from '$lib/utils';
	import type { ToastData } from './toast.svelte';

	type Props = { toast: Pick<ToastData, 'message' | 'kind' | 'action'>; ondismiss?: () => void; class?: string };
	let { toast: t, ondismiss, class: className }: Props = $props();
</script>

<!-- Figma-style toast: a dark pill on both themes, one line, optional action. -->
<div
	class={cn(
		'pointer-events-auto flex h-9 max-w-[420px] items-center gap-2 rounded-panel bg-tooltip pr-1.5 pl-3 text-ui text-fg-tooltip shadow-[0_4px_16px_rgb(0_0_0/0.2)]',
		className
	)}
	role={t.kind === 'error' ? 'alert' : 'status'}
>
	{#if t.kind === 'success'}
		<CircleCheck class="shrink-0 text-inverse-ok" />
	{:else if t.kind === 'error'}
		<CircleAlert class="shrink-0 text-inverse-error" />
	{:else if t.kind === 'loading'}
		<LoaderCircle class="shrink-0 animate-[ps-spin_0.8s_linear_infinite] text-fg-tooltip/70" />
	{/if}
	<span class="min-w-0 truncate">{t.message}</span>
	{#if t.action}
		<button
			type="button"
			class="ml-1 h-6 shrink-0 rounded-control px-2 font-medium text-inverse-accent transition-colors-fast hover:bg-white/10 focus-ring"
			onclick={() => {
				t.action?.onClick();
				ondismiss?.();
			}}>{t.action.label}</button
		>
	{/if}
	<button
		type="button"
		aria-label="Dismiss"
		class="inline-flex size-6 shrink-0 items-center justify-center rounded-control text-fg-tooltip/55 transition-colors-fast hover:bg-white/10 hover:text-fg-tooltip focus-ring"
		onclick={ondismiss}
	>
		<X size={14} />
	</button>
</div>
