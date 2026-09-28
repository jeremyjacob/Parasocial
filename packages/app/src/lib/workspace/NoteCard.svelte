<script lang="ts">
	import { Crosshair, MoreHorizontal, ArrowUp, Check, Trash2, Undo2, Unlink, Bot, Hand } from '@lucide/svelte';
	import { NoteMessage, NoteStatusChip, type NoteMessageData, type NoteSegment, type NoteStatus } from '$lib/components/ui/notes';
	import { IconButton, Button } from '$lib/components/ui/button';
	import { DropdownMenu, type MenuEntry } from '$lib/components/ui/menu';
	import { relativeTime } from '$lib/format';
	import { toast } from '$lib/components/ui/toast';
	import { rise } from '$lib/styles/motion';
	import type { Note, NoteMessage as Msg } from '@parasocial/sync';
	import type { WorkspaceState } from './state.svelte';
	import type { NotesController } from './notes.svelte';

	let { ws, nc, note, onfocus, onversion }: { ws: WorkspaceState; nc: NotesController; note: Note & { messages?: Msg[] }; onfocus: () => void; onversion: (versionID: string) => void } = $props();
	let reply = $state('');

	const status = $derived<NoteStatus>(note.orphaned ? 'orphaned' : note.status === 'Open' ? 'open' : note.status === 'AgentWorking' ? 'working' : 'resolved');
	const t0 = $derived(note.anchor.targets[0]);
	const partName = $derived(t0?.kind === 'studio' ? (ws.partTree.find((g) => g.file === t0.studio)?.name ?? t0.name) : t0?.part ? (ws.results[t0.part]?.name ?? t0.part) : '');
	const kind = $derived(`${t0 ? t0.kind[0].toUpperCase() + t0.kind.slice(1) : 'Point'}${note.anchor.targets.length > 1 ? ` +${note.anchor.targets.length - 1}` : ''}`);
	const resolved = $derived(note.status === 'Resolved');
	const claimant = $derived(status === 'working' ? ((note as any).claimant ?? ws.agents.find((a) => a.id === note.claimedBy)) : null);

	const paramNames = $derived(new Set(Object.values(ws.results).flatMap((r) => r.params.map((p) => p.name))));
	function segments(text: string): NoteSegment[] {
		const out: NoteSegment[] = [];
		let last = 0;
		for (const m of text.matchAll(/(^|[\s(])([@#])([A-Za-z_][\w-]*)/g)) {
			const at = m.index! + m[1].length;
			if (at > last) out.push(text.slice(last, at));
			const name = m[3];
			if (m[2] === '@') out.push({ kind: 'param', name, broken: !paramNames.has(name) });
			else out.push({ kind: 'part', name, broken: !ws.allParts.includes(name) });
			last = at + 1 + name.length;
		}
		if (last < text.length) out.push(text.slice(last));
		return out;
	}

	const messages = $derived.by<NoteMessageData[]>(() => {
		const msgs = note.messages ?? [];
		const out: NoteMessageData[] = [];
		// activity (render, measure, edit …) precedes the agent's reply: hold it until that reply arrives
		let pending: { agentID: string; entry: NoteMessageData } | null = null;
		for (const m of msgs) {
			const agent = (m as any).authorAgent ?? (m.authorAgentID ? ws.agents.find((a) => a.id === m.authorAgentID) ?? { clientName: 'Agent' } : null);
			const author = agent ? { name: agent.clientName, kind: 'agent' as const } : { name: (m as any).authorUser?.name ?? (m.authorUserID === ws.userID ? ws.userName : 'Someone'), kind: 'human' as const };
			const detail = agent?.label as string | undefined;
			if (m.kind === 'activity') {
				if (pending && pending.agentID === m.authorAgentID) pending.entry.activity!.push(m.text);
				else {
					if (pending) out.push(pending.entry);
					pending = { agentID: m.authorAgentID ?? '', entry: { author, detail, time: relativeTime(m.createdAt), body: [], activity: [m.text] } };
				}
				continue;
			}
			const v = m.versionID ? ws.versions.find((x) => x.id === m.versionID) : undefined;
			const entry: NoteMessageData = {
				author,
				detail,
				time: relativeTime(m.createdAt),
				body: segments(m.text),
				// the message already carries a timestamp; the chip only needs the version and what changed
				version: v ? { version: v.number, summary: v.message, onclick: () => onversion(v.id) } : undefined
			};
			if (pending && pending.agentID === m.authorAgentID) entry.activity = pending.entry.activity;
			else if (pending) out.push(pending.entry);
			pending = null;
			out.push(entry);
		}
		if (pending) out.push(pending.entry);
		return out;
	});

	// handed to the built-in agent: stays with it (a reply puts it back to work) until someone takes it back
	const withAgent = $derived(!!note.agentAssignedBy && !resolved && !note.removedAt);
	const agentEntry = $derived<MenuEntry[]>(
		note.removedAt || resolved
			? []
			: note.agentAssignedBy
				? [{ label: 'Take back from agent', icon: Hand, onSelect: () => nc.assignAgent(note.id, false) }]
				: [{ label: 'Hand to agent', icon: Bot, disabled: !!note.claimedBy, onSelect: handToAgent }]
	);
	function handToAgent() {
		if (!ws.agentConfigured) return toast.error('Add an API key to use the built-in agent', { action: { label: 'Settings', onClick: () => (location.href = '/settings#agent') } });
		nc.assignAgent(note.id, true);
	}

	const menu = $derived<MenuEntry[]>([
		{ label: 'Show in viewport', icon: Crosshair, onSelect: onfocus },
		...agentEntry,
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
		<button class="focus-ring flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden rounded-xs text-left" onclick={onfocus} title="Show in viewport">
			<span class="flex min-w-0 items-baseline text-label">
				{#if partName}<span class="truncate text-fg-secondary">{partName}</span><span class="shrink-0 px-1 text-fg-tertiary">·</span>{/if}
				<span class="truncate text-fg-tertiary">{kind}</span>
			</span>
		</button>
		{#if withAgent && status !== 'working'}<span class="flex shrink-0 items-center text-fg-tertiary" title="With the agent: it picks this up, and again after your replies"><Bot size={14} /></span>{/if}
		<!-- "Open" is the default: only call out the states worth noticing -->
		{#if status !== 'open' && !(resolved && !note.removedAt)}<NoteStatusChip {status} label={claimant ? `${claimant.clientName} working` : undefined} class="shrink-0" />{/if}
		{#if !note.removedAt}
			{#if resolved}
				<button
					type="button"
					class="focus-ring inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-ok-subtle pr-2 pl-1.5 text-label font-medium whitespace-nowrap text-ok transition-[filter] duration-[var(--duration-fast)] hover:brightness-95"
					onclick={() => nc.setStatus(note.id, 'Open')}
					aria-label="Reopen"
					title="Reopen"><Check size={12} strokeWidth={2} /> Resolved</button
				>
			{:else}
				<IconButton label="Resolve" size="sm" onclick={() => nc.setStatus(note.id, 'Resolved')} data-testid="note-resolve"><Check /></IconButton>
			{/if}
		{/if}
		<DropdownMenu items={menu} align="end">
			{#snippet trigger(props)}<IconButton {...props} label="Note actions" size="sm"><MoreHorizontal /></IconButton>{/snippet}
		</DropdownMenu>
	</header>
	{#if note.orphaned}
		<div class="flex items-center gap-2 border-b border-line-subtle bg-error-subtle px-3 py-2 text-label text-error">
			<Unlink size={12} /> {t0?.kind === 'studio' ? "Can't find its studio." : "Can't find its geometry."}
			{#if t0?.kind === 'studio'}
				<div class="ml-auto">
					<DropdownMenu items={ws.partTree.map((g) => ({ label: g.name, onSelect: () => nc.reanchorStudio(note.id, g.file) }))}>
						{#snippet trigger(props)}<Button {...props} variant="ghost" size="sm" disabled={!ws.partTree.length}>Reattach</Button>{/snippet}
					</DropdownMenu>
				</div>
			{:else}
				<Button variant="ghost" size="sm" class="ml-auto" onclick={() => ((ws.tool = 'note'), (nc.active = note.id), (nc.reanchoring = note.id))}>{nc.reanchoring === note.id ? 'Click the model…' : 'Reattach'}</Button>
			{/if}
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
					onkeydown={(e) => (e.key === 'Enter' && !e.shiftKey && !e.isComposing ? (e.preventDefault(), send()) : e.key === 'Escape' && (e.currentTarget as HTMLElement).blur())}
					class="field-sizing-content max-h-32 min-h-6 w-full resize-none bg-transparent py-1 text-body text-fg outline-none placeholder:text-fg-tertiary"
				></textarea>
				<IconButton label="Send" shortcut={['enter']} variant={reply ? 'accent' : 'ghost'} active={!!reply} size="sm" disabled={!reply} class="rounded-full" onclick={send}><ArrowUp /></IconButton>
			</div>
		</div>
	{/if}
</div>
