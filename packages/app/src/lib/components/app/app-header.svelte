<script lang="ts">
	import type { Snippet } from 'svelte';
	import { DropdownMenu, type MenuEntry } from '$lib/components/ui/menu';
	import { Avatar } from '$lib/components/ui/avatar';
	import { ThemeToggle } from '$lib/components/ui/theme-toggle';
	import { signOut } from '$lib/auth';
	import Logo from './logo.svelte';

	let { user, title, actions }: { user: { name: string } | null; title?: string; actions?: Snippet } = $props();

	const menu: MenuEntry[] = [
		{ type: 'item', label: 'Documents', onSelect: () => (location.href = '/') },
		{ type: 'item', label: 'Settings', onSelect: () => (location.href = '/settings') },
		{ type: 'separator' },
		{
			type: 'item',
			label: 'Sign out',
			onSelect: async () => {
				await signOut();
				location.href = '/signin';
			}
		}
	];
</script>

<header class="flex h-12 shrink-0 items-center gap-3 border-b border-line-subtle bg-panel px-4">
	<a href="/" class="focus-ring flex items-center gap-2 rounded-control" aria-label="Parasocial home">
		<Logo />
		<span class="text-body font-heading font-medium">Parasocial</span>
	</a>
	{#if title}
		<span class="text-fg-tertiary">/</span>
		<span class="text-body text-fg-secondary">{title}</span>
	{/if}
	<div class="ml-auto flex items-center gap-2">
		{@render actions?.()}
		<ThemeToggle />
		{#if user}
			<DropdownMenu items={menu} align="end">
				{#snippet trigger(props)}
					<button {...props} class="focus-ring rounded-full" aria-label="Account menu" data-testid="account-menu">
						<Avatar name={user.name} kind="human" size={28} />
					</button>
				{/snippet}
			</DropdownMenu>
		{/if}
	</div>
</header>
