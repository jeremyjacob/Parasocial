<script lang="ts">
	// Renders MenuEntry[] with the shared menu primitives (DropdownMenu and ContextMenu share them).
	import { DropdownMenu } from 'bits-ui';
	import { Check, ChevronRight } from '@lucide/svelte';
	import { cn, keyGlyph } from '$lib/utils';
	import { usePortalTarget } from '$lib/theme.svelte';
	import type { MenuEntry } from './types';
	import { menuContent, menuItem, menuItemDestructive, menuLabel, menuSeparator, menuShortcut } from './styles';
	import Self from './menu-entries.svelte';

	let { items }: { items: MenuEntry[] } = $props();
	const portalTarget = usePortalTarget();
</script>

{#snippet shortcut(keys?: string[])}
	{#if keys?.length}
		<span class={menuShortcut}>{keys.map(keyGlyph).join('')}</span>
	{/if}
{/snippet}

{#each items as entry, i (i)}
	{#if entry.type === 'separator'}
		<DropdownMenu.Separator class={menuSeparator} />
	{:else if entry.type === 'label'}
		<div class={menuLabel}>{entry.label}</div>
	{:else if entry.type === 'checkbox'}
		<DropdownMenu.CheckboxItem
			checked={entry.checked}
			onCheckedChange={entry.onCheckedChange}
			class={cn(menuItem, 'group/item pl-7')}
		>
			{#snippet children({ checked })}
				{#if checked}<Check class="absolute left-2" size={14} strokeWidth={2} />{/if}
				<span class="truncate">{entry.label}</span>
				{@render shortcut(entry.shortcut)}
			{/snippet}
		</DropdownMenu.CheckboxItem>
	{:else if entry.type === 'sub'}
		<DropdownMenu.Sub>
			<DropdownMenu.SubTrigger class={cn(menuItem, 'group/item data-[state=open]:bg-hover')}>
				{#if entry.icon}<entry.icon />{/if}
				<span class="truncate">{entry.label}</span>
				<ChevronRight class="ml-auto" size={14} />
			</DropdownMenu.SubTrigger>
			<DropdownMenu.Portal to={portalTarget()}>
				<DropdownMenu.SubContent class={menuContent} sideOffset={6} alignOffset={-4}>
					<Self items={entry.items} />
				</DropdownMenu.SubContent>
			</DropdownMenu.Portal>
		</DropdownMenu.Sub>
	{:else}
		<DropdownMenu.Item
			disabled={entry.disabled}
			onSelect={entry.onSelect}
			class={cn(menuItem, 'group/item', entry.destructive && menuItemDestructive)}
		>
			{#if entry.icon}<entry.icon />{/if}
			<span class="truncate">{entry.label}</span>
			{@render shortcut(entry.shortcut)}
		</DropdownMenu.Item>
	{/if}
{/each}
