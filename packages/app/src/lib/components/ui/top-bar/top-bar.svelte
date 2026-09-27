<script lang="ts">
	import { ChevronDown, Command as CommandIcon, Hexagon } from '@lucide/svelte';
	import { cn } from '$lib/utils';
	import { DropdownMenu, type MenuEntry } from '$lib/components/ui/menu';
	import { SegmentedControl } from '$lib/components/ui/segmented-control';
	import { AvatarStack, Avatar, type Person } from '$lib/components/ui/avatar';
	import { IconButton, Button } from '$lib/components/ui/button';
	import { Select, type SelectItem } from '$lib/components/ui/select';
	import { ThemeToggle } from '$lib/components/ui/theme-toggle';

	type Props = {
		document: string;
		configurations: SelectItem[];
		configuration?: string;
		mode?: 'model' | 'code';
		agents: Person[];
		user: Person;
		documentMenu?: MenuEntry[];
		onCommand?: () => void;
		/** Right-side actions (e.g. Connect agent), before the account avatar. */
		actions?: import('svelte').Snippet;
		/** Account control; defaults to a plain avatar. */
		account?: import('svelte').Snippet;
		/** Presence control; defaults to the agent avatar stack. */
		presence?: import('svelte').Snippet;
		class?: string;
	};
	let {
		document: docName,
		configurations,
		configuration = $bindable('default'),
		mode = $bindable('model'),
		agents,
		user,
		documentMenu = [{ label: 'Rename' }, { label: 'Duplicate' }, { label: 'Export…', shortcut: ['mod', 'shift', 'E'] }],
		onCommand,
		actions,
		account,
		presence,
		class: className
	}: Props = $props();
</script>

<!-- 44px bar: three zones (document · mode · presence) on a 4px grid. -->
<header
	class={cn(
		'relative grid h-11 shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-line-subtle bg-panel px-2',
		className
	)}
>
	<div class="flex min-w-0 items-center gap-1">
		<DropdownMenu items={documentMenu}>
			{#snippet trigger(props)}
				<button
					{...props}
					class="inline-flex h-7 min-w-0 items-center gap-2 rounded-control pr-1.5 pl-2 text-ui font-semibold text-fg transition-colors-fast hover:bg-hover focus-ring data-[state=open]:bg-active"
				>
					<span class="grid size-5 place-items-center rounded-[5px] bg-fg text-panel">
						<Hexagon size={12} strokeWidth={2.25} />
					</span>
					<span class="truncate">{docName}</span>
					<ChevronDown size={12} class="shrink-0 text-fg-tertiary" />
				</button>
			{/snippet}
		</DropdownMenu>
		<span class="h-4 w-px bg-line" aria-hidden="true"></span>
		<Select variant="ghost" items={configurations} bind:value={configuration} aria-label="Configuration" class="text-fg-secondary" />
	</div>

	<SegmentedControl
		aria-label="Mode"
		bind:value={mode}
		items={[
			{ value: 'model', text: 'Model' },
			{ value: 'code', text: 'Code' }
		]}
		class="w-40"
	/>

	<div class="flex items-center justify-end gap-1">
		{#if presence}
			{@render presence()}
		{:else if agents.length}
			<span class="mr-1 flex items-center gap-1.5">
				<AvatarStack people={agents} size={24} />
				<span class="text-label text-fg-secondary tabular">{agents.length}</span>
			</span>
		{/if}
		<IconButton label="Command palette" shortcut={['mod', 'K']} onclick={onCommand}><CommandIcon /></IconButton>
		<ThemeToggle variant="menu" />
		{#if actions}{@render actions()}{/if}
		{#if account}{@render account()}{:else}<Avatar {...user} size={28} class="ml-1.5" />{/if}
	</div>
</header>
