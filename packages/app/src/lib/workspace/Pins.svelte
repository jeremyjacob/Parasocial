<script lang="ts">
	// Note pins (§6 UX): sit on their geometry, hide when occluded, cluster when zoomed out,
	// ghost (dashed) when orphaned. Numbers indicate cluster counts. Hovering a pin
	// for a beat expands it into a peek at the note (Figma-style).
	import { onMount, onDestroy } from 'svelte';
	import * as THREE from 'three';
	import type { Viewer } from '@parasocial/viewer';
	import { LoaderCircle } from '@lucide/svelte';
	import { Avatar } from '$lib/components/ui/avatar';
	import { relativeTime } from '$lib/format';
	import { fadeOut } from '$lib/styles/motion';
	import type { NotesController, Pin } from './notes.svelte';
	import type { WorkspaceState } from './state.svelte';

	let { ws, viewer, nc, onopen }: { ws: WorkspaceState; viewer: Viewer; nc: NotesController; onopen: (noteID: string) => void } = $props();

	const PEEK_DELAY = 200;
	const PEEK_WIDTH = 248;
	let peek = $state<{ id: string; flip: boolean } | null>(null);
	let peekTimer: ReturnType<typeof setTimeout> | undefined;
	function enter(p: Pin, e: MouseEvent) {
		nc.hovered = p.noteID;
		clearTimeout(peekTimer);
		const host = (e.currentTarget as HTMLElement).offsetParent as HTMLElement | null;
		const x = (e.currentTarget as HTMLElement).offsetLeft;
		peekTimer = setTimeout(() => (peek = { id: p.noteID, flip: !!host && x + PEEK_WIDTH > host.clientWidth - 8 }), PEEK_DELAY);
	}
	function leave(p: Pin) {
		clearTimeout(peekTimer);
		peek = null;
		if (nc.hovered === p.noteID) nc.hovered = null;
	}
	function open(p: Pin) {
		clearTimeout(peekTimer);
		peek = null;
		onopen(p.noteID);
	}
	/** First message, author and reply count for the peek. */
	const peeked = $derived.by(() => {
		if (!peek) return null;
		const note = ws.notes.find((n) => n.id === peek!.id) as any;
		const msgs = ((note?.messages ?? []) as { kind?: string; text: string }[]).filter((m) => m.kind !== 'activity');
		if (!note) return null;
		const agent = note.status === 'AgentWorking' ? (note.claimant ?? ws.agents.find((a) => a.id === note.claimedBy)) : null;
		return { text: msgs[0]?.text ?? '', replies: Math.max(0, msgs.length - 1), time: relativeTime(note.createdAt), working: note.status === 'AgentWorking' ? (agent?.clientName ?? 'Agent') : null };
	});

	type Placed = { pins: Pin[]; x: number; y: number };
	let placed = $state.raw<Placed[]>([]);
	let occluded = new Set<string>();
	let raf = 0;
	let offs: (() => void)[] = [];

	// only the studio in the viewport: pins on other studios' parts (or other assemblies' copies) wait there
	const shown = $derived(nc.pins.filter((p) => ws.shownParts.includes(p.part) && !p.removed && (p.status !== 'Resolved' || nc.hovered === p.noteID || nc.active === p.noteID)));
	/** Pins are in part coordinates; assembly parts may have moved. */
	const at = (p: Pin) => viewer.toWorld(p.part, new THREE.Vector3(...p.point));

	function layout() {
		raf = 0;
		const out: Placed[] = [];
		for (const p of shown) {
			if (occluded.has(p.noteID) && !p.orphaned && nc.active !== p.noteID) continue;
			const s = viewer.project(at(p));
			if (!s) continue;
			// cluster pins that land within 22px of each other
			const near = out.find((c) => Math.hypot(c.x - s.x, c.y - s.y) < 22);
			if (near) near.pins.push(p);
			else out.push({ pins: [p], x: s.x, y: s.y });
		}
		placed = out;
	}
	const schedule = () => (raf ||= requestAnimationFrame(layout));

	function occlusion() {
		const next = new Set<string>();
		const vis = viewer.pointsVisible(shown.map(at));
		shown.forEach((p, i) => !vis[i] && next.add(p.noteID));
		occluded = next;
		schedule();
	}

	onMount(() => {
		offs.push(viewer.on('camera', schedule));
		// dragging an assembly moves pins with their parts; occlusion once it settles
		let settle: ReturnType<typeof setTimeout> | undefined;
		offs.push(viewer.on('poses', () => (schedule(), clearTimeout(settle), (settle = setTimeout(occlusion, 150)))));
		offs.push(viewer.on('moving', (on: boolean) => !on && occlusion()));
		occlusion();
	});
	onDestroy(() => {
		clearTimeout(peekTimer);
		offs.forEach((f) => f());
		cancelAnimationFrame(raf);
	});
	$effect(() => {
		shown;
		nc.active;
		queueMicrotask(occlusion);
	});

	function zoomTo(c: Placed) {
		const box = new THREE.Box3();
		for (const p of c.pins) box.expandByPoint(at(p));
		box.expandByScalar(Math.max(5, box.getSize(new THREE.Vector3()).length() * 0.3));
		viewer.fit(box, true);
	}
</script>

{#each placed as c (c.pins[0].noteID)}
	{@const p = c.pins[0]}
	{#if c.pins.length > 1}
		<button
			class="pin cluster focus-ring"
			style="left:{c.x}px;top:{c.y}px"
			onclick={() => zoomTo(c)}
			aria-label="{c.pins.length} notes here — zoom in"
			data-testid="pin-cluster"
		>{c.pins.length}</button>
	{:else}
		<!-- zero-size anchor at the pin's point: pin and peek share its hover -->
		<div class="anchor" class:peeking={peek?.id === p.noteID} style="left:{c.x}px;top:{c.y}px" role="presentation" onmouseenter={(e) => enter(p, e)} onmouseleave={() => leave(p)}>
			<button
				class="pin focus-ring"
				class:ghost={p.orphaned}
				class:active={nc.active === p.noteID || nc.hovered === p.noteID}
				class:resolved={p.status === 'Resolved'}
				class:working={p.status === 'AgentWorking'}
				onclick={() => open(p)}
				aria-label="Note #{p.number}{p.orphaned ? ' (orphaned)' : ''}"
				data-testid="pin"
			>
				<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
					<path d="M2 4h8M2 8h5" />
				</svg>
			</button>
			{#if peek?.id === p.noteID && peeked}
				<button class="peek focus-ring" class:flip={peek.flip} style="width:{PEEK_WIDTH}px" onclick={() => open(p)} out:fadeOut={{ duration: 80 }} data-testid="pin-peek">
					<span class="flex items-center gap-2">
						<Avatar name={p.authorName} kind={p.authorKind} size={20} />
						<span class="truncate text-ui font-semibold text-fg">{p.authorName}</span>
						<span class="ml-auto shrink-0 text-label text-fg-tertiary">{peeked.time}</span>
					</span>
					{#if peeked.text}<span class="line-clamp-3 text-body text-fg [overflow-wrap:anywhere]">{peeked.text}</span>{/if}
					{#if p.orphaned}<span class="text-label text-error">Lost its geometry</span>{/if}
					{#if peeked.working}<span class="flex items-center gap-1.5 text-label font-medium text-accent-fg"
							><LoaderCircle size={12} strokeWidth={2} class="shrink-0 animate-[ps-spin_1s_linear_infinite] motion-reduce:animate-none" /><span class="truncate">{peeked.working} is working on this…</span></span
						>{/if}
					{#if peeked.replies}<span class="text-label text-fg-tertiary">{peeked.replies} {peeked.replies === 1 ? 'reply' : 'replies'}</span>{/if}
				</button>
			{/if}
		</div>
	{/if}
{/each}

<style>
	.anchor {
		position: absolute;
		z-index: 6;
		width: 0;
		height: 0;
	}
	.anchor.peeking {
		z-index: 7;
	}
	/* Keep the hover target in place while the note replaces the visible pin. */
	.anchor.peeking .pin {
		opacity: 0;
	}
	/* Grows out of the pin: same bottom-left "tail" corner, same anchor. */
	.peek {
		position: absolute;
		left: -12px;
		bottom: 4px;
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 10px 12px;
		border-radius: 14px 14px 14px 3px;
		background: var(--color-elevated);
		box-shadow: var(--shadow-popover);
		text-align: left;
		cursor: default;
		transform-origin: 0 100%;
		animation: peek-grow var(--duration-base) var(--ease-out);
	}
	.peek.flip {
		left: auto;
		right: -12px;
		border-radius: 14px 14px 3px 14px;
		transform-origin: 100% 100%;
	}
	@keyframes peek-grow {
		from {
			opacity: 0;
			transform: scale(0.12);
		}
		40% {
			opacity: 1;
		}
	}
	.pin {
		position: absolute;
		display: flex;
		align-items: center;
		justify-content: center;
		left: 0;
		top: 0;
		transform: translate(-50%, -100%) translateY(-4px);
		width: 24px;
		height: 24px;
		padding: 0;
		border-radius: 12px 12px 12px 3px;
		background: #fff;
		color: #202023;
		font: 600 11px/24px var(--font-sans);
		font-variant-numeric: tabular-nums;
		box-shadow: var(--pin-inset, 0 0 transparent), 0 1px 2px rgb(0 0 0 / 0.18), 0 0 0 1px rgb(0 0 0 / 0.16);
		transform-origin: 50% 100%;
		transition:
			transform var(--duration-fast) var(--ease-out),
			background-color var(--duration-fast) var(--ease-out),
			color var(--duration-fast) var(--ease-out),
			opacity var(--duration-fast) var(--ease-out),
			box-shadow var(--duration-fast) var(--ease-out);
		/* Drops onto its geometry when it appears (placed, un-occluded, or un-clustered). */
		animation: pin-drop var(--duration-base) var(--ease-out);
		cursor: default;
	}
	.pin:hover,
	.pin.active {
		transform: translate(-50%, -100%) translateY(-5px);
		box-shadow: var(--pin-inset, 0 0 transparent), 0 3px 8px rgb(0 0 0 / 0.22), 0 0 0 1px rgb(0 0 0 / 0.25);
	}
	.pin:active {
		transform: translate(-50%, -100%) translateY(-4px);
		transition-duration: var(--duration-instant);
	}
	@keyframes pin-drop {
		from {
			opacity: 0;
			transform: translate(-50%, -100%) translateY(-12px) scale(0.6);
		}
	}
	/* Claimed by an agent: stays white, with an accent glow fading in from the rim
	   (inset shadow, so it follows the tail corner). */
	.pin.working {
		--pin-inset: inset 0 0 5px 1px color-mix(in oklab, var(--color-accent) 75%, transparent);
	}
	.pin.resolved {
		opacity: 0.6;
	}
	.pin.ghost {
		background: transparent;
		color: var(--color-error);
		outline: 1.5px dashed var(--color-error);
		box-shadow: none;
	}
	.pin.cluster {
		z-index: 6;
		width: auto;
		min-width: 24px;
		padding: 0 6px;
		border-radius: 12px;
		background: var(--color-elevated);
		color: var(--color-fg);
		box-shadow: var(--shadow-popover);
	}
	@media (prefers-reduced-motion: reduce) {
		.pin,
		.peek {
			transition: none;
			animation: none;
		}
	}
</style>
