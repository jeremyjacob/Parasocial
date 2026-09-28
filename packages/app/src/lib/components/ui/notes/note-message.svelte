<script lang="ts" module>
	export type NoteSegment =
		| string
		| { kind: 'param' | 'part' | 'entity'; name: string; color?: string; broken?: boolean };

	export type NoteMessageData = {
		author: import('$lib/components/ui/avatar').Person;
		/** Secondary author line, e.g. the agent's session label. */
		detail?: string;
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
	// Agent replies run long: clamp them, offering the toggle only when the clamp actually cuts text
	let bodyEl = $state<HTMLParagraphElement>();
	let expanded = $state(false);
	let overflows = $state(false);
	$effect(() => {
		if (!bodyEl || !isAgent) return;
		const el = bodyEl;
		void message.body; // re-measure as a streaming reply grows past the clamp (the box height stops changing then)
		const measure = () => {
			if (!expanded) overflows = el.scrollHeight > el.clientHeight + 1;
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	});
</script>

<article class={cn('flex gap-2.5', className)}>
	<Avatar {...message.author} size={24} class="mt-0.5" />
	<div class="flex min-w-0 flex-1 flex-col gap-0">
		<header class="flex h-5 min-w-0 items-baseline gap-1.5">
			<span class="max-w-[70%] shrink-0 truncate text-ui font-semibold text-fg">{message.author.name}</span>
			{#if message.detail || isAgent}<span class="min-w-0 truncate text-label text-fg-tertiary" title={message.detail}>{message.detail ?? 'Agent'}</span>{/if}
			<time class="ml-auto shrink-0 pl-1 text-label whitespace-nowrap text-fg-tertiary tabular">{message.time}</time>
		</header>
		{#if message.activity?.length}
			<div class="flex flex-col">
				<button
					type="button"
					aria-expanded={logOpen}
					onclick={() => (logOpen = !logOpen)}
					class="-my-0.5 -ml-1 inline-flex h-6 w-fit items-center gap-1 rounded-sm px-1 text-label text-fg-tertiary hover:text-fg-secondary focus-ring"
				>
					<ChevronRight size={12} class={cn('transition-transform duration-[var(--duration-fast)]', logOpen && 'rotate-90')} />
					{message.activity.length} {message.activity.length === 1 ? 'step' : 'steps'}
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
		{#if message.body.length}<p bind:this={bodyEl} class={cn('text-body text-fg [overflow-wrap:anywhere]', isAgent && !expanded && 'line-clamp-4')}>
			{#each message.body as seg, i (i)}{#if typeof seg === 'string'}{seg}{:else}<MentionChip
						kind={seg.kind}
						name={seg.name}
						color={seg.color}
						broken={seg.broken}
					/>{/if}{/each}
		</p>{/if}
		{#if overflows}
			<button
				type="button"
				aria-expanded={expanded}
				onclick={() => (expanded = !expanded)}
				class="-my-0.5 -ml-1 inline-flex h-6 w-fit items-center rounded-sm px-1 text-label text-fg-tertiary hover:text-fg-secondary focus-ring"
			>
				{expanded ? 'Show less' : 'Show more'}
			</button>
		{/if}
		{#if message.version}
			<VersionChip {...message.version} class="mt-0.5 w-full" />
		{/if}
	</div>
</article>
