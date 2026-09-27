<script lang="ts">
	import { ArrowUp, Crosshair, MoreHorizontal } from '@lucide/svelte';
	import { cn } from '$lib/utils';
	import { IconButton } from '$lib/components/ui/button';
	import NoteMessage, { type NoteMessageData } from './note-message.svelte';
	import NoteStatusChip, { type NoteStatus } from './note-status-chip.svelte';

	type Props = {
		number: number;
		status: NoteStatus;
		/** What the note is pinned to: "Face · Bracket". */
		target: string;
		/** Source location of the target's operation. */
		source?: string;
		messages: NoteMessageData[];
		/** Show the reply composer. */
		composer?: boolean;
		class?: string;
	};
	let { number, status, target, source, messages, composer = true, class: className }: Props = $props();
	let reply = $state('');
</script>

<div class={cn('flex flex-col rounded-panel bg-panel shadow-[inset_0_0_0_1px_var(--border-default)]', className)}>
	<header class="flex h-10 items-center gap-2 border-b border-line-subtle pr-1.5 pl-3">
		<span class="flex min-w-0 flex-1 items-center gap-1 text-label text-fg-secondary">
			<Crosshair size={12} class="shrink-0 text-fg-tertiary" />
			<span class="truncate">{target}</span>
			{#if source}<span class="min-w-0 truncate font-mono text-fg-tertiary">{source}</span>{/if}
		</span>
		<span class="shrink-0 text-label text-fg-tertiary tabular-nums">Note #{number}</span>
		<NoteStatusChip {status} />
		<IconButton label="More" size="sm"><MoreHorizontal /></IconButton>
	</header>
	<div class="flex flex-col gap-4 px-3 py-3">
		{#each messages as m, i (i)}
			<NoteMessage message={m} />
		{/each}
	</div>
	{#if composer}
		<div class="px-3 pb-3">
			<div class="field h-auto min-h-8 items-end gap-1 py-1 pr-1 pl-2.5">
				<textarea
					bind:value={reply}
					rows="1"
					placeholder="Reply…"
					aria-label="Reply"
					class="field-sizing-content max-h-32 min-h-6 w-full resize-none bg-transparent py-1 text-body text-fg outline-none placeholder:text-fg-tertiary"
				></textarea>
				<IconButton
					label="Send"
					shortcut={['mod', 'enter']}
					variant={reply ? 'accent' : 'ghost'}
					active={!!reply}
					size="sm"
					disabled={!reply}
					class="rounded-full"
				>
					<ArrowUp />
				</IconButton>
			</div>
		</div>
	{/if}
</div>
