<script lang="ts">
	// Note pins (§6 UX): sit on their geometry, hide when occluded, cluster when zoomed out,
	// ghost (dashed) when orphaned. Avatars distinguish the human from each agent.
	import { onMount, onDestroy } from 'svelte';
	import * as THREE from 'three';
	import type { Viewer } from '@parasocial/viewer';
	import type { NotesController, Pin } from './notes.svelte';

	let { viewer, nc, onopen }: { viewer: Viewer; nc: NotesController; onopen: (noteID: string) => void } = $props();

	type Placed = { pins: Pin[]; x: number; y: number };
	let placed = $state.raw<Placed[]>([]);
	let occluded = new Set<string>();
	let raf = 0;
	let offs: (() => void)[] = [];

	const shown = $derived(nc.pins.filter((p) => !p.removed && (p.status !== 'Resolved' || nc.hovered === p.noteID || nc.active === p.noteID)));
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
		<button
			class="pin focus-ring"
			class:agent={p.authorKind === 'agent'}
			class:ghost={p.orphaned}
			class:active={nc.active === p.noteID || nc.hovered === p.noteID}
			class:resolved={p.status === 'Resolved'}
			class:working={p.status === 'AgentWorking'}
			style="left:{c.x}px;top:{c.y}px"
			onclick={() => onopen(p.noteID)}
			onmouseenter={() => (nc.hovered = p.noteID)}
			onmouseleave={() => nc.hovered === p.noteID && (nc.hovered = null)}
			aria-label="Note #{p.number}{p.orphaned ? ' (orphaned)' : ''}"
			title="{p.authorName}{p.orphaned ? ' · lost its geometry' : ''}"
			data-testid="pin"
		>{p.number}</button>
	{/if}
{/each}

<style>
	.pin {
		position: absolute;
		z-index: 6;
		transform: translate(-50%, -100%) translateY(-4px);
		min-width: 24px;
		height: 24px;
		padding: 0 6px;
		border-radius: 12px 12px 12px 3px;
		background: var(--color-fg);
		color: var(--color-panel);
		font: 600 11px/24px var(--font-sans);
		font-variant-numeric: tabular-nums;
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.18), 0 0 0 1.5px var(--color-panel);
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
		transform: translate(-50%, -100%) translateY(-5px) scale(1.12);
		box-shadow: 0 3px 8px rgb(0 0 0 / 0.22), 0 0 0 1.5px var(--color-panel);
	}
	.pin:active {
		transform: translate(-50%, -100%) translateY(-4px) scale(1.04);
		transition-duration: var(--duration-instant);
	}
	@keyframes pin-drop {
		from {
			opacity: 0;
			transform: translate(-50%, -100%) translateY(-12px) scale(0.6);
		}
	}
	.pin.agent {
		background: var(--color-agent, #2a2a30);
		color: #fff;
	}
	.pin.working {
		background: var(--color-accent);
		color: var(--color-fg-on-accent);
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
		border-radius: 12px;
		background: var(--color-elevated);
		color: var(--color-fg);
		box-shadow: var(--shadow-popover);
	}
	@media (prefers-reduced-motion: reduce) {
		.pin {
			transition: none;
			animation: none;
		}
	}
</style>
