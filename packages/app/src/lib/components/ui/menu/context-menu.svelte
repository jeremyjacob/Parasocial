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
	};
	let { items, children, class: className }: Props = $props();
	const portalTarget = usePortalTarget();
</script>

<ContextMenu.Root>
	<ContextMenu.Trigger class={className}>
		{@render children()}
	</ContextMenu.Trigger>
	<ContextMenu.Portal to={portalTarget()}>
		<ContextMenu.Content collisionPadding={8} class={cn(menuContent, 'min-w-[220px]')}>
			<MenuEntries {items} />
		</ContextMenu.Content>
	</ContextMenu.Portal>
</ContextMenu.Root>
