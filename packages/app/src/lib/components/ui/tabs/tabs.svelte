<script lang="ts" module>
	export type TabItem = { value: string; label: string; count?: number; disabled?: boolean };
</script>

<script lang="ts">
	import { Tabs } from 'bits-ui';
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';

	type Props = {
		value?: string;
		items: TabItem[];
		/** Right-aligned slot in the tab row (e.g. zoom %, an action). */
		actions?: Snippet;
		/** One snippet per tab value: content[value]. Optional; tabs can drive external content. */
		content?: Snippet<[string]>;
		class?: string;
		listClass?: string;
		onValueChange?: (v: string) => void;
	};
	let {
		value = $bindable(''),
		items,
		actions,
		content,
		class: className,
		listClass,
		onValueChange
	}: Props = $props();
</script>

<!-- Panel tabs (Figma "Design · Prototype", Framer "Pages · Layers"): quiet text, active gets a soft pill. -->
<Tabs.Root bind:value {onValueChange} class={cn('flex min-h-0 flex-col', className)}>
	<div class={cn('flex h-10 shrink-0 items-center gap-1 px-2', listClass)}>
		<Tabs.List class="flex items-center gap-0.5">
			{#each items as item (item.value)}
				<Tabs.Trigger
					value={item.value}
					disabled={item.disabled}
					class={cn(
						'inline-flex h-7 items-center gap-1.5 rounded-control px-2 text-ui font-medium text-fg-secondary select-none focus-ring transition-colors-fast',
						'hover:text-fg data-[state=active]:bg-active data-[state=active]:text-fg disabled:opacity-40'
					)}
				>
					{item.label}
					{#if item.count !== undefined}
						<span class="text-label text-fg-tertiary tabular">{item.count}</span>
					{/if}
				</Tabs.Trigger>
			{/each}
		</Tabs.List>
		{#if actions}<div class="ml-auto flex items-center gap-0.5">{@render actions()}</div>{/if}
	</div>
	{#if content}
		{#each items as item (item.value)}
			<Tabs.Content value={item.value} class="animate-tab flex min-h-0 flex-1 flex-col focus-visible:outline-none">
				{@render content(item.value)}
			</Tabs.Content>
		{/each}
	{/if}
</Tabs.Root>
