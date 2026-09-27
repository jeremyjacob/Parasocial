<script lang="ts">
	import { RotateCcw } from '@lucide/svelte';
	import { Dialog } from '$lib/components/ui/dialog';
	import { Select } from '$lib/components/ui/select';
	import { Kbd } from '$lib/components/ui/kbd';
	import { IconButton } from '$lib/components/ui/button';
	import { comboOf, comboOfKeys, RESERVED, saveCustomKeys, type Command } from './commands';

	let {
		open = $bindable(false),
		commands,
		custom = $bindable({}),
		nav = $bindable('onshape')
	}: { open?: boolean; commands: Command[]; custom?: Record<string, string[]>; nav?: string } = $props();

	let recording = $state<string | null>(null);
	let error = $state('');
	const keyOf = (c: Command) => custom[c.id] ?? c.keys;

	const conflictsWith = (id: string, combo: string) => commands.find((c) => c.id !== id && keyOf(c) && comboOfKeys(keyOf(c)!) === combo);

	function onKey(e: KeyboardEvent) {
		if (!recording) return;
		e.preventDefault();
		e.stopPropagation();
		if (e.key === 'Escape') return void (recording = null);
		if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return;
		const combo = comboOf(e);
		if (RESERVED.has(combo)) return void (error = `${combo} is reserved by the browser`);
		const other = conflictsWith(recording, combo);
		if (other) return void (error = `Already used by “${other.label}”`);
		const keys = combo.split('+').map((k) => (k.length === 1 ? k.toUpperCase() : k));
		custom = { ...custom, [recording]: keys };
		saveCustomKeys(custom);
		recording = null;
		error = '';
	}

	function reset(id: string) {
		const { [id]: _, ...rest } = custom;
		custom = rest;
		saveCustomKeys(custom);
	}
</script>

<svelte:window onkeydowncapture={onKey} />

<Dialog bind:open title="Preferences" class="max-w-[560px]">
	<div class="flex flex-col gap-4" data-testid="preferences">
		<div class="flex items-center gap-3 text-ui">
			<span class="w-28 text-fg-secondary">Navigation</span>
			<Select
				bind:value={nav}
				items={[
					{ value: 'onshape', label: 'Onshape', hint: 'right-drag orbit' },
					{ value: 'solidworks', label: 'SolidWorks', hint: 'middle-drag orbit' },
					{ value: 'fusion', label: 'Fusion', hint: 'shift+middle orbit' },
					{ value: 'trackpad', label: 'Trackpad', hint: 'two-finger orbit' }
				]}
				class="w-56"
				aria-label="Navigation preset"
			/>
		</div>
		<div class="flex flex-col">
			<div class="mb-1 text-ui text-fg-secondary">Shortcuts</div>
			<div class="max-h-[50vh] overflow-auto rounded-md border border-line-subtle">
				{#each commands.filter((c) => c.keys) as c (c.id)}
					<div class="flex h-9 items-center gap-2 border-b border-line-subtle px-3 text-ui last:border-0">
						<span class="flex-1 truncate">{c.label}</span>
						<button class="focus-ring rounded-control px-1.5 py-0.5 hover:bg-hover {recording === c.id ? 'bg-accent-subtle' : ''}" onclick={() => ((recording = c.id), (error = ''))} data-testid="shortcut-{c.id}">
							{#if recording === c.id}<span class="text-label text-accent">Press keys…</span>{:else}<Kbd keys={keyOf(c)!} />{/if}
						</button>
						<IconButton label="Reset" size="sm" class={custom[c.id] ? '' : 'invisible'} onclick={() => reset(c.id)}><RotateCcw /></IconButton>
					</div>
				{/each}
			</div>
			{#if error}<p class="mt-2 text-label text-error" role="alert">{error}</p>{/if}
		</div>
	</div>
</Dialog>
