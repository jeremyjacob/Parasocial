<script lang="ts">
	import { Combobox } from 'bits-ui';
	import { Check, ChevronsUpDown } from '@lucide/svelte';
	import { cn } from '$lib/utils';
	import { usePortalTarget } from '$lib/theme.svelte';
	import { floatingSurface, menuItem } from '$lib/components/ui/menu/styles';
	import type { SelectItem } from './select.svelte';

	type Props = {
		value?: string;
		items: SelectItem[];
		placeholder?: string;
		disabled?: boolean;
		class?: string;
		'aria-label'?: string;
		emptyText?: string;
		onValueChange?: (v: string) => void;
	};
	let {
		value = $bindable(''),
		items,
		placeholder = 'Search…',
		disabled,
		class: className,
		'aria-label': ariaLabel,
		emptyText = 'No matches',
		onValueChange
	}: Props = $props();

	let search = $state('');
	let open = $state(false);
	const filtered = $derived(
		search ? items.filter((i) => i.label.toLowerCase().includes(search.toLowerCase())) : items
	);
	const selected = $derived(items.find((i) => i.value === value));
	const portalTarget = usePortalTarget();
</script>

<Combobox.Root
	type="single"
	bind:value
	bind:open
	items={filtered}
	{disabled}
	onValueChange={(v) => {
		search = '';
		onValueChange?.(v);
	}}
	onOpenChange={(o) => {
		if (!o) search = '';
	}}
>
	<div class={cn('field w-full pr-1 pl-2', className)} data-disabled={disabled ? '' : undefined}>
		<Combobox.Input
			aria-label={ariaLabel}
			{placeholder}
			defaultValue={selected?.label}
			oninput={(e) => (search = e.currentTarget.value)}
			class="h-full w-full min-w-0 bg-transparent text-ui text-fg outline-none placeholder:text-fg-tertiary"
		/>
		<Combobox.Trigger
			class="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-fg-tertiary hover:text-fg"
			aria-label="Show options"
		>
			<ChevronsUpDown size={14} />
		</Combobox.Trigger>
	</div>
	<Combobox.Portal to={portalTarget()}>
		<Combobox.Content
			sideOffset={4}
			collisionPadding={8}
			class={cn(floatingSurface, 'max-h-64 min-w-[var(--bits-combobox-anchor-width)]')}
		>
			<Combobox.Viewport>
				{#each filtered as item (item.value)}
					<Combobox.Item value={item.value} label={item.label} class={cn(menuItem, 'group/item pl-7')}>
						{#snippet children({ selected: isSel })}
							{#if isSel}<Check class="absolute left-2" size={14} strokeWidth={2} />{/if}
							{#if item.icon}<item.icon />{/if}
							<span class="truncate">{item.label}</span>
							{#if item.hint}
								<span class="ml-auto pl-4 text-label text-fg-tertiary group-data-[highlighted]/item:text-fg-on-accent/70"
									>{item.hint}</span
								>
							{/if}
						{/snippet}
					</Combobox.Item>
				{:else}
					<div class="px-2 py-1.5 text-ui text-fg-tertiary">{emptyText}</div>
				{/each}
			</Combobox.Viewport>
		</Combobox.Content>
	</Combobox.Portal>
</Combobox.Root>
