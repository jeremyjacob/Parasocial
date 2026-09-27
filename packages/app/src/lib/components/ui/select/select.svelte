<script lang="ts" module>
	import type { LucideIcon } from '@lucide/svelte';
	export type SelectItem = { value: string; label: string; icon?: LucideIcon; hint?: string; disabled?: boolean };
</script>

<script lang="ts">
	import { Select } from 'bits-ui';
	import { Check, ChevronDown } from '@lucide/svelte';
	import { cn } from '$lib/utils';
	import { usePortalTarget } from '$lib/theme.svelte';
	import { floatingSurface, menuItem } from '$lib/components/ui/menu/styles';

	type Props = {
		value?: string;
		items: SelectItem[];
		placeholder?: string;
		/** `field`: filled like an input. `ghost`: bare text + chevron (top bar, section titles). */
		variant?: 'field' | 'ghost';
		size?: 'sm' | 'md';
		disabled?: boolean;
		invalid?: boolean;
		/** Leading glyph inside the trigger (Figma "Inside ▾" with a stroke icon). */
		icon?: LucideIcon;
		class?: string;
		'aria-label'?: string;
		onValueChange?: (v: string) => void;
	};
	let {
		value = $bindable(''),
		items,
		placeholder = 'Select…',
		variant = 'field',
		size = 'md',
		disabled,
		invalid,
		icon: Icon,
		class: className,
		'aria-label': ariaLabel,
		onValueChange
	}: Props = $props();

	const selected = $derived(items.find((i) => i.value === value));
	const portalTarget = usePortalTarget();
</script>

<Select.Root type="single" bind:value {items} {disabled} {onValueChange}>
	<Select.Trigger
		aria-label={ariaLabel}
		data-invalid={invalid ? '' : undefined}
		data-disabled={disabled ? '' : undefined}
		class={cn(
			'group/sel gap-1.5 text-left select-none focus-visible:outline-none',
			variant === 'field'
				? 'field w-full pr-1.5 pl-2'
				: 'inline-flex h-7 items-center rounded-control px-2 font-medium text-fg transition-colors-fast hover:bg-hover focus-ring data-[state=open]:bg-hover',
			size === 'sm' && 'h-6',
			className
		)}
	>
		{#if Icon}<Icon class="shrink-0 text-fg-tertiary" />{:else if selected?.icon}<selected.icon
				class="shrink-0 text-fg-secondary"
			/>{/if}
		<span class={cn('min-w-0 flex-1 truncate', !selected && 'text-fg-tertiary')}>
			{selected?.label ?? placeholder}
		</span>
		<ChevronDown
			size={14}
			class="shrink-0 text-fg-tertiary transition-transform duration-[var(--duration-fast)] group-data-[state=open]/sel:rotate-180"
		/>
	</Select.Trigger>
	<Select.Portal to={portalTarget()}>
		<Select.Content
			sideOffset={4}
			collisionPadding={8}
			class={cn(floatingSurface, 'max-h-[var(--bits-select-content-available-height)] min-w-[var(--bits-select-anchor-width)]')}
		>
			<Select.Viewport>
				{#each items as item (item.value)}
					<Select.Item value={item.value} label={item.label} disabled={item.disabled} class={cn(menuItem, 'group/item pl-7')}>
						{#snippet children({ selected: isSel })}
							{#if isSel}<Check class="absolute left-2" size={14} strokeWidth={2} />{/if}
							{#if item.icon}<item.icon />{/if}
							<span class="truncate">{item.label}</span>
							{#if item.hint}
								<span class="ml-auto pl-4 text-label text-fg-tertiary tabular group-data-[highlighted]/item:text-fg-on-accent/70"
									>{item.hint}</span
								>
							{/if}
						{/snippet}
					</Select.Item>
				{/each}
			</Select.Viewport>
		</Select.Content>
	</Select.Portal>
</Select.Root>
