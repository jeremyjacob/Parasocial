<script lang="ts">
	import { Checkbox, Label } from 'bits-ui';
	import { Check, Minus } from '@lucide/svelte';
	import { cn } from '$lib/utils';

	type Props = {
		checked?: boolean;
		indeterminate?: boolean;
		disabled?: boolean;
		/** Optional inline label; the whole row is clickable (Figma "Clip content"). */
		label?: string;
		class?: string;
		id?: string;
		onCheckedChange?: (v: boolean) => void;
	};
	let {
		checked = $bindable(false),
		indeterminate = $bindable(false),
		disabled,
		label,
		class: className,
		id,
		onCheckedChange
	}: Props = $props();
	const uid = $props.id();
	const cid = $derived(id ?? `cb-${uid}`);
</script>

<div class={cn('inline-flex h-7 items-center gap-2', disabled && 'opacity-40', className)}>
	<Checkbox.Root
		id={cid}
		bind:checked
		bind:indeterminate
		{disabled}
		{onCheckedChange}
		class={cn(
			'peer inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-fg-on-accent focus-ring transition-colors-fast',
			'bg-control shadow-[inset_0_0_0_1px_var(--border-strong)] hover:shadow-[inset_0_0_0_1px_var(--fg-tertiary)]',
			'data-[state=checked]:bg-accent data-[state=checked]:shadow-none data-[state=indeterminate]:bg-accent data-[state=indeterminate]:shadow-none'
		)}
	>
		{#snippet children({ checked: c, indeterminate: ind })}
			{#if ind}
				<Minus size={12} strokeWidth={2.5} />
			{:else if c}
				<Check size={12} strokeWidth={2.5} />
			{/if}
		{/snippet}
	</Checkbox.Root>
	{#if label}
		<Label.Root for={cid} class="text-ui text-fg select-none">{label}</Label.Root>
	{/if}
</div>
