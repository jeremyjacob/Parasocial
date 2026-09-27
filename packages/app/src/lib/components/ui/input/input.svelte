<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';

	type Props = Omit<HTMLInputAttributes, 'size'> & {
		value?: string;
		/** Leading glyph (icon or single-letter label like Figma's "W"). */
		leading?: Snippet;
		trailing?: Snippet;
		invalid?: boolean;
		/** Inline message shown under the field when invalid. */
		error?: string;
		size?: 'sm' | 'md';
		ref?: HTMLInputElement | null;
		class?: string;
		inputClass?: string;
	};
	let {
		value = $bindable(''),
		leading,
		trailing,
		invalid = false,
		error,
		size = 'md',
		disabled,
		ref = $bindable(null),
		class: className,
		inputClass,
		...rest
	}: Props = $props();

	const errorId = $props.id();
</script>

<div class={cn('flex min-w-0 flex-col gap-1', className)}>
	<div
		class={cn('field gap-1.5 px-2', size === 'sm' && 'h-6')}
		data-invalid={invalid || error ? '' : undefined}
		data-disabled={disabled ? '' : undefined}
	>
		{#if leading}
			<span class="flex shrink-0 items-center text-fg-tertiary">{@render leading()}</span>
		{/if}
		<input
			bind:this={ref}
			bind:value
			{disabled}
			aria-invalid={invalid || !!error || undefined}
			aria-describedby={error ? errorId : undefined}
			class={cn(
				'h-full w-full min-w-0 bg-transparent text-ui text-fg outline-none placeholder:text-fg-tertiary',
				inputClass
			)}
			{...rest}
		/>
		{#if trailing}
			<span class="flex shrink-0 items-center text-fg-tertiary">{@render trailing()}</span>
		{/if}
	</div>
	{#if error}
		<p id={errorId} class="text-label text-error">{error}</p>
	{/if}
</div>
