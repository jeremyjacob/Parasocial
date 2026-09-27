<script lang="ts">
	import { Sun, Moon, Monitor } from '@lucide/svelte';
	import { theme, type ThemePreference } from '$lib/theme.svelte';
	import { SegmentedControl } from '$lib/components/ui/segmented-control';
	import { DropdownMenu } from '$lib/components/ui/menu';
	import { IconButton } from '$lib/components/ui/button';

	/** `segmented`: three-way control (settings, /design). `menu`: one icon button (top bar). */
	let { variant = 'segmented' }: { variant?: 'segmented' | 'menu' } = $props();

	const Icon = $derived(theme.preference === 'system' ? Monitor : theme.preference === 'dark' ? Moon : Sun);
</script>

{#if variant === 'segmented'}
	<SegmentedControl
		aria-label="Theme"
		size="sm"
		value={theme.preference}
		onValueChange={(v) => theme.set(v as ThemePreference)}
		items={[
			{ value: 'light', icon: Sun, label: 'Light' },
			{ value: 'dark', icon: Moon, label: 'Dark' },
			{ value: 'system', icon: Monitor, label: 'System' }
		]}
	/>
{:else}
	<DropdownMenu
		align="end"
		items={[
			{ type: 'label', label: 'Theme' },
			{ type: 'checkbox', label: 'Light', checked: theme.preference === 'light', onCheckedChange: () => theme.set('light') },
			{ type: 'checkbox', label: 'Dark', checked: theme.preference === 'dark', onCheckedChange: () => theme.set('dark') },
			{ type: 'checkbox', label: 'System', checked: theme.preference === 'system', onCheckedChange: () => theme.set('system') }
		]}
	>
		{#snippet trigger(props)}
			<IconButton {...props} label="Theme" tooltip={false}><Icon /></IconButton>
		{/snippet}
	</DropdownMenu>
{/if}
