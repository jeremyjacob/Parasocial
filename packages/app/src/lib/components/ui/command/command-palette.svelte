<script lang="ts" module>
	import type { LucideIcon } from '@lucide/svelte';
	export type CommandItem = {
		id: string;
		label: string;
		icon?: LucideIcon;
		shortcut?: string[];
		/** Quiet right-aligned context ("Param · Bracket", "Note #12"). */
		hint?: string;
		keywords?: string[];
		onSelect?: () => void;
	};
	export type CommandGroup = { heading: string; items: CommandItem[] };
</script>

<script lang="ts">
	import { Command, Dialog } from 'bits-ui';
	import { Search } from '@lucide/svelte';
	import { cn, keyGlyph } from '$lib/utils';
	import { usePortalTarget } from '$lib/theme.svelte';
	import { Kbd } from '$lib/components/ui/kbd';

	type Props = {
		open?: boolean;
		groups: CommandGroup[];
		placeholder?: string;
		/** Bind ⌘K / Ctrl+K globally to toggle the palette. */
		hotkey?: boolean;
		/** Render in place (docs, screenshots) instead of in a modal. */
		inline?: boolean;
		class?: string;
	};
	let {
		open = $bindable(false),
		groups,
		placeholder = 'Search actions, params, notes…',
		hotkey = true,
		inline = false,
		class: className
	}: Props = $props();

	let search = $state('');
	const portalTarget = usePortalTarget();

	function onWindowKey(e: KeyboardEvent) {
		if (!hotkey || inline) return;
		if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			open = !open;
		}
	}

	function run(item: CommandItem) {
		open = false;
		search = '';
		item.onSelect?.();
	}
</script>

<svelte:window onkeydown={onWindowKey} />

{#snippet palette()}
	<Command.Root
		class={cn('flex max-h-[min(440px,70vh)] w-full flex-col overflow-hidden', className)}
		loop
		disableInitialScroll
	>
		<div class="flex h-11 shrink-0 items-center gap-2.5 border-b border-line-subtle px-4">
			<Search class="text-fg-tertiary" />
			<Command.Input
				bind:value={search}
				{placeholder}
				class="h-full w-full bg-transparent text-body text-fg outline-none placeholder:text-fg-tertiary"
			/>
		</div>
		<Command.List class="min-h-0 flex-1 overflow-y-auto p-1.5">
			<Command.Viewport>
				<Command.Empty class="px-3 py-6 text-center text-ui text-fg-tertiary">No results</Command.Empty>
				{#each groups as group (group.heading)}
					<Command.Group>
						<Command.GroupHeading class="px-2.5 pt-2 pb-1 text-label font-medium text-fg-tertiary">
							{group.heading}
						</Command.GroupHeading>
						<Command.GroupItems>
							{#each group.items as item (item.id)}
								<Command.Item
									value={item.id}
									keywords={[item.label, ...(item.keywords ?? [])]}
									onSelect={() => run(item)}
									class={cn(
										'group/ci flex h-8 cursor-default items-center gap-2.5 rounded-md px-2.5 text-ui text-fg outline-none select-none',
										'data-[selected]:bg-active'
									)}
								>
									{#if item.icon}<item.icon class="shrink-0 text-fg-secondary group-data-[selected]/ci:text-fg" />{/if}
									<span class="truncate">{item.label}</span>
									{#if item.hint}<span class="truncate text-fg-tertiary">{item.hint}</span>{/if}
									{#if item.shortcut}
										<Kbd keys={item.shortcut} class="ml-auto" />
									{/if}
								</Command.Item>
							{/each}
						</Command.GroupItems>
					</Command.Group>
				{/each}
			</Command.Viewport>
		</Command.List>
		<div
			class="flex h-9 shrink-0 items-center gap-4 border-t border-line-subtle px-4 text-label text-fg-tertiary"
		>
			<span class="flex items-center gap-1.5"><Kbd keys={['up']} /><Kbd keys={['down']} /> Navigate</span>
			<span class="flex items-center gap-1.5"><Kbd keys={['enter']} /> Run</span>
			<span class="ml-auto flex items-center gap-1.5"><Kbd keys={['esc']} /> Close</span>
		</div>
	</Command.Root>
{/snippet}

{#if inline}
	<div class="w-full overflow-hidden rounded-panel bg-elevated shadow-dialog">{@render palette()}</div>
{:else}
	<Dialog.Root bind:open>
		<Dialog.Portal to={portalTarget()}>
			<Dialog.Overlay class="animate-fade fixed inset-0 z-50 bg-overlay" />
			<Dialog.Content
				class="fixed top-[18vh] left-1/2 z-50 w-[min(560px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-panel bg-elevated shadow-dialog outline-none data-[state=open]:animate-[ps-fade-in_var(--duration-fast)_var(--ease-out)]"
			>
				<Dialog.Title class="sr-only">Command palette</Dialog.Title>
				{@render palette()}
			</Dialog.Content>
		</Dialog.Portal>
	</Dialog.Root>
{/if}
