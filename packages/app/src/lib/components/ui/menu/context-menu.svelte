<script lang="ts">
	import { ContextMenu } from 'bits-ui';
	import type { Snippet } from 'svelte';
	import { usePortalTarget } from '$lib/theme.svelte';
	import type { MenuEntry } from './types';
	import { menuContent } from './styles';
	import MenuEntries from './menu-entries.svelte';
	import { cn } from '$lib/utils';

	type Props = {
		items: MenuEntry[];
		/** The right-clickable region. */
		children: Snippet;
		class?: string;
		/** Runs as the menu opens, before it renders `items`. */
		onOpen?: () => void;
	};
	let { items, children, class: className, onOpen }: Props = $props();
	const portalTarget = usePortalTarget();
</script>

<ContextMenu.Root onOpenChange={(open) => open && onOpen?.()}>
	<ContextMenu.Trigger class={className} disabled={items.length === 0}>
		{@render children()}
	</ContextMenu.Trigger>
	<ContextMenu.Portal to={portalTarget()}>
		<ContextMenu.Content collisionPadding={8} class={cn(menuContent, 'min-w-[220px]')}>
			<MenuEntries {items} />
		</ContextMenu.Content>
	</ContextMenu.Portal>
</ContextMenu.Root>
