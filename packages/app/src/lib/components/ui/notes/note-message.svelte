<script lang="ts" module>
	export type NoteSegment =
		| string
		| { kind: 'param' | 'part' | 'entity'; name: string; color?: string; broken?: boolean };

	export type NoteMessageData = {
		author: import('$lib/components/ui/avatar').Person;
		time: string;
		body: NoteSegment[];
		version?: { version: number; time?: string; summary?: string; onclick?: () => void };
		/** Agent activity log (render, measure, edit …), collapsible. */
		activity?: string[];
	};
</script>

<script lang="ts">
	import { ChevronRight } from '@lucide/svelte';
	import { cn } from '$lib/utils';
	import { Avatar } from '$lib/components/ui/avatar';
	import MentionChip from './mention-chip.svelte';
	import VersionChip from './version-chip.svelte';

	let { message, class: className }: { message: NoteMessageData; class?: string } = $props();
	let logOpen = $state(false);
	const isAgent = $derived(message.author.kind === 'agent');
</script>

<article class={cn('flex gap-2.5', className)}>
	<Avatar {...message.author} size={24} class="mt-0.5" />
	<div class="flex min-w-0 flex-1 flex-col gap-1.5">
		<header class="flex h-5 items-baseline gap-1.5">
			<span class="truncate text-ui font-semibold text-fg">{message.author.name}</span>
			{#if isAgent}<span class="text-label text-fg-tertiary">Agent</span>{/if}
			<time class="ml-auto shrink-0 text-label text-fg-tertiary tabular">{message.time}</time>
		</header>
		<p class="text-body text-fg [overflow-wrap:anywhere]">
			{#each message.body as seg, i (i)}{#if typeof seg === 'string'}{seg}{:else}<MentionChip
						kind={seg.kind}
						name={seg.name}
						color={seg.color}
						broken={seg.broken}
					/>{/if}{/each}
		</p>
		{#if message.version}
			<VersionChip {...message.version} class="self-start" />
		{/if}
		{#if message.activity?.length}
			<div class="flex flex-col">
				<button
					type="button"
					aria-expanded={logOpen}
					onclick={() => (logOpen = !logOpen)}
					class="-ml-1 inline-flex h-6 w-fit items-center gap-1 rounded-sm px-1 text-label text-fg-tertiary hover:text-fg-secondary focus-ring"
				>
					<ChevronRight size={12} class={cn('transition-transform duration-[var(--duration-fast)]', logOpen && 'rotate-90')} />
					{message.activity.length} steps
				</button>
				{#if logOpen}
					<ol class="ml-1.5 flex flex-col gap-1 border-l border-line py-1 pl-3">
						{#each message.activity as step, i (i)}
							<li class="font-mono text-label text-fg-secondary">{step}</li>
						{/each}
					</ol>
				{/if}
			</div>
		{/if}
	</div>
</article>
