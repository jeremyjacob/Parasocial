<script lang="ts">
	import { ChevronDown, ArrowUpRight, LoaderCircle } from '@lucide/svelte';
	import { cn } from '$lib/utils';

	type Props = {
		tone: 'error' | 'warning' | 'pending' | 'preview';
		/** One calm line: "Bracket didn't regenerate". */
		title: string;
		/** Quiet suffix: "agents notified". */
		detail?: string;
		/** Expanded body: the actual message. Omit for non-expandable pills. */
		message?: string;
		/** Source link text ("bracket.ts:18"). */
		source?: string;
		onSourceClick?: () => void;
		expanded?: boolean;
		class?: string;
	};
	let {
		tone,
		title,
		detail,
		message,
		source,
		onSourceClick,
		expanded = $bindable(false),
		class: className
	}: Props = $props();
	const uid = $props.id();
	const dot: Record<Props['tone'], string> = {
		error: 'bg-error',
		warning: 'bg-warning',
		pending: '',
		preview: 'bg-accent'
	};
	const expandable = $derived(!!message);
</script>

<!-- Quiet viewport status (never a banner). The pill grows into a small card when expanded. -->
<div
	class={cn(
		'inline-flex max-w-[380px] flex-col overflow-hidden bg-elevated text-ui shadow-toolbar transition-[border-radius] duration-[var(--duration-base)]',
		expanded ? 'rounded-panel' : 'rounded-[14px]',
		className
	)}
	role={tone === 'error' ? 'alert' : 'status'}
>
	<button
		type="button"
		disabled={!expandable}
		aria-expanded={expandable ? expanded : undefined}
		aria-controls={expandable ? `sp-${uid}` : undefined}
		onclick={() => (expanded = !expanded)}
		class="flex h-7 items-center gap-2 pr-2 pl-3 text-left focus-ring enabled:hover:bg-hover"
		style="border-radius:inherit"
	>
		{#if tone === 'pending'}
			<LoaderCircle size={14} class="shrink-0 animate-[ps-spin_0.8s_linear_infinite] text-fg-tertiary" />
		{:else}
			<span class={cn('size-1.5 shrink-0 rounded-full', dot[tone])}></span>
		{/if}
		<span class="truncate font-medium text-fg">{title}</span>
		{#if detail}<span class="shrink-0 text-fg-tertiary">· {detail}</span>{/if}
		{#if expandable}
			<ChevronDown
				size={14}
				class={cn(
					'ml-0.5 shrink-0 text-fg-tertiary transition-transform duration-[var(--duration-fast)]',
					expanded && 'rotate-180'
				)}
			/>
		{/if}
	</button>
	{#if expandable && expanded}
		<div id="sp-{uid}" class="flex flex-col gap-2 border-t border-line-subtle px-3 pt-2 pb-3">
			<p class="text-ui text-fg-secondary">{message}</p>
			{#if source}
				<button
					type="button"
					onclick={onSourceClick}
					class="inline-flex w-fit items-center gap-1 rounded-sm font-mono text-label font-medium text-accent-fg hover:underline focus-ring"
				>
					{source}<ArrowUpRight size={12} />
				</button>
			{/if}
		</div>
	{/if}
</div>
