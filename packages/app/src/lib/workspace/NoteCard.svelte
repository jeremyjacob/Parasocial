<script lang="ts">
	import { Crosshair, MoreHorizontal, ArrowUp, Check, RotateCcw, Trash2, Undo2, Unlink } from '@lucide/svelte';
	import { NoteMessage, NoteStatusChip, type NoteMessageData, type NoteSegment, type NoteStatus } from '$lib/components/ui/notes';
	import { IconButton, Button } from '$lib/components/ui/button';
	import { DropdownMenu, type MenuEntry } from '$lib/components/ui/menu';
	import { clockTime, relativeTime } from '$lib/format';
	import { rise } from '$lib/styles/motion';
	import type { Note, NoteMessage as Msg } from '@parasocial/sync';
	import type { WorkspaceState } from './state.svelte';
	import type { NotesController, Pin } from './notes.svelte';

	let { ws, nc, note, pin, onfocus, onversion }: { ws: WorkspaceState; nc: NotesController; note: Note & { messages?: Msg[] }; pin?: Pin; onfocus: () => void; onversion: (versionID: string) => void } = $props();
	let reply = $state('');

	const status = $derived<NoteStatus>(note.orphaned ? 'orphaned' : note.status === 'Open' ? 'open' : note.status === 'AgentWorking' ? 'working' : note.status === 'AwaitingReview' ? 'review' : 'resolved');
	const t0 = $derived(note.anchor.targets[0]);
	const partName = $derived(t0?.part ? (ws.results[t0.part]?.name ?? t0.part) : '');
	const target = $derived(`${t0 ? t0.kind[0].toUpperCase() + t0.kind.slice(1) : 'Point'}${note.anchor.targets.length > 1 ? ` +${note.anchor.targets.length - 1}` : ''} · ${partName}`);

	const paramNames = $derived(new Set(Object.values(ws.results).flatMap((r) => r.params.map((p) => p.name))));
	function segments(text: string): NoteSegment[] {
		const out: NoteSegment[] = [];
		let last = 0;
		for (const m of text.matchAll(/(^|[\s(])([@#])([A-Za-z_][\w-]*)/g)) {
			const at = m.index! + m[1].length;
			if (at > last) out.push(text.slice(last, at));
			const name = m[3];
			if (m[2] === '@') out.push({ kind: 'param', name, broken: !paramNames.has(name) });
			else out.push({ kind: 'part', name, broken: !ws.parts.includes(name) });
			last = at + 1 + name.length;
		}
		if (last < text.length) out.push(text.slice(last));
		return out;
	}

	const messages = $derived.by<NoteMessageData[]>(() => {
		const msgs = note.messages ?? [];
		const out: NoteMessageData[] = [];
		for (const m of msgs) {
			const agent = (m as any).authorAgent ?? (m.authorAgentID ? ws.agents.find((a) => a.id === m.authorAgentID) ?? { clientName: 'Agent' } : null);
			const author = agent ? { name: `${agent.clientName}${agent.label ? ` (${agent.label})` : ''}`, kind: 'agent' as const } : { name: (m as any).authorUser?.name ?? (m.authorUserID === ws.userID ? ws.userName : 'Someone'), kind: 'human' as const };
			if (m.kind === 'activity') {
				// activity entries fold into the agent's previous message (or start a log)
				const prev = out[out.length - 1];
				if (prev && prev.author.kind === 'agent') (prev.activity ??= []).push(m.text);
				else out.push({ author, time: clockTime(m.createdAt), body: [], activity: [m.text] });
				continue;
			}
			const v = m.versionID ? ws.versions.find((x) => x.id === m.versionID) : undefined;
			out.push({
				author,
				time: relativeTime(m.createdAt),
				body: segments(m.text),
				version: v ? { version: v.number, time: clockTime(v.createdAt), summary: v.message, onclick: () => onversion(v.id) } : undefined
			});
		}
		return out;
	});

	const menu = $derived<MenuEntry[]>([
		note.status === 'Resolved' ? { label: 'Reopen', icon: RotateCcw, onSelect: () => nc.setStatus(note.id, 'Open') } : { label: 'Resolve', icon: Check, onSelect: () => nc.setStatus(note.id, 'Resolved') },
		{ label: 'Show in viewport', icon: Crosshair, onSelect: onfocus },
		{ type: 'separator' },
		note.removedAt ? { label: 'Restore', icon: Undo2, onSelect: () => nc.restore(note.id) } : { label: 'Remove', icon: Trash2, destructive: true, onSelect: () => nc.remove(note.id) }
	]);

	function send() {
		const text = reply.trim();
		if (!text) return;
		nc.reply(note.id, text);
		reply = '';
	}
</script>

<div
	class="flex flex-col rounded-panel bg-panel transition-[box-shadow,opacity] duration-[var(--duration-fast)] ease-out {nc.active === note.id ? 'shadow-[inset_0_0_0_1px_var(--border-focus)]' : 'shadow-[inset_0_0_0_1px_var(--border-default)] hover:shadow-[inset_0_0_0_1px_var(--border-strong)]'} {note.removedAt ? 'opacity-60' : ''}"
	onmouseenter={() => (nc.hovered = note.id)}
	onmouseleave={() => nc.hovered === note.id && (nc.hovered = null)}
	role="article"
	data-testid="note-card"
>
	<header class="flex h-10 items-center gap-2 border-b border-line-subtle pr-1.5 pl-3">
		<button class="focus-ring flex min-w-0 items-center gap-2 rounded-xs text-left" onclick={onfocus}>
			<span class="text-ui font-semibold text-fg tabular-nums">#{pin?.number ?? nc.numberOf(note.id)}</span>
			<span class="flex min-w-0 items-center gap-1 text-label text-fg-secondary">
				<Crosshair size={12} class="shrink-0 text-fg-tertiary" />
				<span class="truncate">{target}</span>
			</span>
		</button>
		<NoteStatusChip {status} class="ml-auto shrink-0" />
		<DropdownMenu items={menu} align="end">
			{#snippet trigger(props)}<IconButton {...props} label="Note actions" size="sm"><MoreHorizontal /></IconButton>{/snippet}
		</DropdownMenu>
	</header>
	{#if note.orphaned}
		<div class="flex items-center gap-2 border-b border-line-subtle bg-error-subtle px-3 py-2 text-label text-error">
			<Unlink size={12} /> Can't find its geometry. <Button variant="ghost" size="sm" class="ml-auto" onclick={() => ((ws.tool = 'note'), (nc.active = note.id), (nc.reanchoring = note.id))}>{nc.reanchoring === note.id ? 'Click the model…' : 'Reattach'}</Button>
		</div>
	{/if}
	<div class="flex flex-col gap-4 px-3 py-3">
		{#each messages as m, i (i)}<div in:rise><NoteMessage message={m} /></div>{/each}
		{#if !messages.length}<p class="text-label text-fg-tertiary">No messages.</p>{/if}
	</div>
	{#if !note.removedAt}
		<div class="px-3 pb-3">
			<div class="field h-auto min-h-8 items-end gap-1 py-1 pr-1 pl-2.5">
				<textarea
					bind:value={reply}
					rows="1"
					placeholder="Reply…"
					aria-label="Reply"
					onkeydown={(e) => (e.key === 'Enter' && (e.metaKey || e.ctrlKey) ? (e.preventDefault(), send()) : e.key === 'Escape' && (e.currentTarget as HTMLElement).blur())}
					class="field-sizing-content max-h-32 min-h-6 w-full resize-none bg-transparent py-1 text-body text-fg outline-none placeholder:text-fg-tertiary"
				></textarea>
				<IconButton label="Send" shortcut={['mod', 'enter']} variant={reply ? 'accent' : 'ghost'} active={!!reply} size="sm" disabled={!reply} class="rounded-full" onclick={send}><ArrowUp /></IconButton>
			</div>
		</div>
	{/if}
</div>
