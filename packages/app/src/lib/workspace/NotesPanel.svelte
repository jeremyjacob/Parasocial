<script lang="ts">
	import { Kbd } from '$lib/components/ui/kbd';
	import { Select } from '$lib/components/ui/select';
	import { flip } from 'svelte/animate';
	import { rise, fadeOut, flipDuration, easeOut } from '$lib/styles/motion';
	import NoteCard from './NoteCard.svelte';
	import type { WorkspaceState } from './state.svelte';
	import type { NotesController } from './notes.svelte';

	let { ws, nc, onfocus, onversion }: { ws: WorkspaceState; nc: NotesController; onfocus: (noteID: string) => void; onversion: (versionID: string) => void } = $props();

	const statusItems = [
		{ value: 'all', label: 'All' },
		{ value: 'open', label: 'Open' },
		{ value: 'resolved', label: 'Done' },
		{ value: 'removed', label: 'Removed' }
	];
	const authors = $derived([...new Set(ws.notes.map((n) => ((n as any).authorAgent ? (n as any).authorAgent.clientName : ((n as any).authorUser?.name ?? 'You'))))]);
	const list = $derived(
		ws.notes
			.filter((n) => {
				const f = nc.filter;
				if (f.status === 'removed') {
					if (!n.removedAt) return false;
				} else if (n.removedAt) return false;
				if (f.status === 'open' && !(n.status === 'Open' || n.status === 'AgentWorking')) return false;
				if (f.status === 'resolved' && n.status !== 'Resolved') return false;
				if (f.part !== 'all' && !n.anchor.targets.some((t) => t.kind === 'studio' ? `studio:${t.studio}` === f.part : t.part === f.part)) return false;
				const who = (n as any).authorAgent ? (n as any).authorAgent.clientName : ((n as any).authorUser?.name ?? 'You');
				if (f.author !== 'all' && who !== f.author) return false;
				return true;
			})
			.sort((a, b) => b.updatedAt - a.updatedAt)
	);
</script>

<div class="flex min-h-0 flex-1 flex-col" data-testid="notes-panel">
	{#if ws.notes.length}
		<div class="grid grid-cols-3 gap-1 border-b border-line-subtle p-2">
			<Select size="sm" items={statusItems} value={nc.filter.status} onValueChange={(v) => (nc.filter = { ...nc.filter, status: v as any })} aria-label="Filter by status" />
			<Select size="sm" items={[{ value: 'all', label: 'All targets' }, ...ws.partTree.map((g) => ({ value: `studio:${g.file}`, label: `Studio: ${g.name}` })), ...ws.allParts.map((p) => ({ value: p, label: ws.results[p]?.name ?? p }))]} value={nc.filter.part} onValueChange={(v) => (nc.filter = { ...nc.filter, part: v })} aria-label="Filter by target" />
			<Select size="sm" items={[{ value: 'all', label: 'Anyone' }, ...authors.map((a) => ({ value: a, label: a }))]} value={nc.filter.author} onValueChange={(v) => (nc.filter = { ...nc.filter, author: v })} aria-label="Filter by author" />
		</div>
	{/if}
	<div class="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2">
		{#each list as n (n.id)}
			<div class="shrink-0" animate:flip={{ duration: flipDuration(), easing: easeOut }} in:rise={{ y: 6, scale: 0.98, duration: 200 }} out:fadeOut>
				<NoteCard {ws} {nc} note={n as any} onfocus={() => onfocus(n.id)} {onversion} />
			</div>
		{:else}
			<div class="flex flex-col gap-2 px-2 py-4 text-ui text-fg-secondary" in:rise>
				{#if ws.notes.length}
					<p>No notes match these filters.</p>
				{:else}
					<p>No notes yet.</p>
					<p class="text-label leading-6 [&_kbd]:mx-0.5">Press <Kbd keys={['C']} /> and click the model.</p>
					{#if !ws.agentReady}
						<p class="text-label" data-testid="notes-agent-hint">Notes are how you ask an agent for changes. <a href="/settings#agent" class="text-accent hover:underline">Add an API key</a> or connect a coding agent to have them picked up.</p>
					{/if}
				{/if}
			</div>
		{/each}
	</div>
</div>
