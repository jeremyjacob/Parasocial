<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import type { Snippet } from 'svelte';
	import { usePortalTarget } from '$lib/theme.svelte';
	import type { MenuEntry } from './types';
	import { menuContent } from './styles';
	import MenuEntries from './menu-entries.svelte';
	import { cn } from '$lib/utils';

	type Props = {
		items: MenuEntry[];
		open?: boolean;
		side?: 'top' | 'right' | 'bottom' | 'left';
		align?: 'start' | 'center' | 'end';
		/** Spread `props` onto the trigger element (e.g. an IconButton or Button). */
		trigger: Snippet<[Record<string, unknown>]>;
		class?: string;
	};
	let { items, open = $bindable(false), side = 'bottom', align = 'start', trigger, class: className }: Props =
		$props();
	const portalTarget = usePortalTarget();
</script>

<DropdownMenu.Root bind:open>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}{@render trigger(props)}{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Portal to={portalTarget()}>
		<DropdownMenu.Content {side} {align} sideOffset={6} collisionPadding={8} class={cn(menuContent, className)}>
			<MenuEntries {items} />
		</DropdownMenu.Content>
	</DropdownMenu.Portal>
</DropdownMenu.Root>
