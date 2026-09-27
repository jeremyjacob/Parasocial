<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { dev } from '$app/environment';
	import { Copy, EyeOff, MessageCircle, Layers, Plus, Bot, Box, X, FlipVertical2, Scissors, SquareDashed } from '@lucide/svelte';
	import { Viewer, type EntityRef } from '@parasocial/viewer';
	import { FloatingToolbar, StatusPill, ViewportControls } from '$lib/components/ui/viewport';
	import { ProgressLine, EmptyState } from '$lib/components/ui/feedback';
	import { ContextMenu, type MenuEntry } from '$lib/components/ui/menu';
	import { Button, IconButton } from '$lib/components/ui/button';
	import { SegmentedControl } from '$lib/components/ui/segmented-control';
	import { Slider } from '$lib/components/ui/slider';
	import { toast } from '$lib/components/ui/toast';
	import { theme } from '$lib/theme.svelte';
	import { num } from '$lib/format';
	import { viewerTheme } from './viewer-theme';
	import type { WorkspaceState } from './state.svelte';
	import { STROKE_COLORS, type NotesController, type DraftTarget } from './notes.svelte';
	import { mutators } from '@parasocial/sync';
	import { newID } from '$lib/zero';
	import * as THREE from 'three';
	import Pins from './Pins.svelte';
	import { sourcePart } from '@parasocial/runtime/protocol';
	import { pairReadouts, singleReadouts, type Readout } from './measure';
	import NoteComposer from './NoteComposer.svelte';
	import { rise, fadeOut, pop, popOut } from '$lib/styles/motion';

	let { ws, nc, onAddStudio, onConnect, onOpenNote }: { ws: WorkspaceState; nc: NotesController; onAddStudio: () => void; onConnect: () => void; onOpenNote: (id: string) => void } = $props();

	let host: HTMLDivElement;
	let viewer: Viewer | null = $state.raw(null);
	let pillOpen = $state(false);
	let ctxTarget = $state.raw<EntityRef | null>(null);
	let down: { x: number; y: number; button: number } | null = null;
	/** Box select: left-drag in the select tool. Left→right = window, right→left = crossing. */
	let box = $state<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
	/**
	 * Dragging a part of an assembly (select tool, left button on a part that can move). It starts
	 * once the pointer moves; a click without moving still selects. The grabbed point follows the
	 * cursor on a plane facing the camera, through the solver.
	 */
	let partDrag: { part: string; local: [number, number, number]; plane: THREE.Plane; x: number; y: number; started: boolean } | null = null;
	/** Tab cycles through the faces stacked under the cursor (§8 Selection). */
	let stack: { x: number; y: number; refs: EntityRef[]; i: number } | null = null;
	let pointer: { x: number; y: number } | null = null;
	let camMoving = false;
	/** ms the pointer must rest on an entity before it preselects */
	const HOVER_DELAY = 20;
	let hoverTimer: ReturnType<typeof setTimeout> | undefined;
	const dark = $derived(theme.resolved === 'dark');

	// macOS fires contextmenu on right mouse-down, which would open the menu at the start of a
	// right-drag orbit. Swallow native ones; open the menu ourselves on a release without a drag.
	let synthetic = false;
	function onContextCapture(e: MouseEvent) {
		if (synthetic) return;
		e.preventDefault();
		e.stopPropagation();
	}
	function onRightUp(e: PointerEvent) {
		if (e.button !== 2 || !down || down.button !== 2) return;
		const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4;
		if (moved) return;
		// right-click selects like a left click first (keeping a selection it lands inside), so the menu acts on it
		if (ws.tool === 'select') {
			const ref = ctxTarget;
			if (!ref) ws.clearSelection();
			else if (!ws.selection.some((s) => s.part === ref.part && s.kind === ref.kind && s.index === ref.index)) ws.select([ref]);
		}
		synthetic = true;
		host.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY, button: 2 }));
		synthetic = false;
	}

	function onTab(e: KeyboardEvent) {
		if (e.key !== 'Tab' || !pointer || !viewer || e.metaKey || e.ctrlKey || e.altKey) return;
		const t = e.target as HTMLElement | null;
		if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
		// only while the pointer is over the viewport; otherwise Tab moves focus as usual
		if (!host.matches(':hover')) return;
		e.preventDefault();
		if (!stack || stack.x !== pointer.x || stack.y !== pointer.y) stack = { x: pointer.x, y: pointer.y, refs: viewer.facesUnder(pointer.x, pointer.y), i: -1 };
		if (!stack.refs.length) return;
		stack.i = (stack.i + (e.shiftKey ? -1 : 1) + stack.refs.length) % stack.refs.length;
		clearTimeout(hoverTimer);
		ws.hover = stack.refs[stack.i];
		viewer.setPreselect(ws.hover);
	}

	// dev-only FPS readout: frames actually rendered (the viewer renders on demand, so idle reads 0)
	let fps = $state<{ fps: number; ms: number } | null>(null);
	let stopFps: (() => void) | undefined;
	function trackFps(v: Viewer) {
		let n = 0,
			t = performance.now();
		const off = v.on('rendered', () => n++);
		const id = setInterval(() => {
			const now = performance.now();
			fps = { fps: Math.round((n * 1000) / (now - t)), ms: v.stats.lastFrameMs };
			n = 0;
			t = now;
		}, 500);
		return () => (off(), clearInterval(id));
	}

	let stopOverlayNav: (() => void) | undefined;
	/** A pinch anywhere in the workspace would zoom the whole page (Chrome: ctrl+wheel, Safari: gesture events). */
	const noPageZoom = (e: Event) => {
		if (e.type !== 'wheel' || (e as WheelEvent).ctrlKey) e.preventDefault();
	};

	onMount(() => {
		window.addEventListener('keydown', onTab);
		host.addEventListener('contextmenu', onContextCapture, { capture: true });
		host.addEventListener('pointerup', onRightUp);
		// the cube sits left of the view controls (top-right, 32px wide + 12px inset)
		viewer = new Viewer(host, { theme: viewerTheme(dark), viewCubeInset: { top: 4, right: 8 } });
		// a remount (HMR) takes over the previous viewer's meshes and camera
		if (ws.attachViewer(viewer)) fitted = true;
		// wheel/pinch over the overlays (pins, pills, toolbars) still navigates
		stopOverlayNav = viewer.listenOn(host.parentElement ?? host);
		window.addEventListener('wheel', noPageZoom, { passive: false });
		window.addEventListener('gesturestart', noPageZoom);
		(window as any).__viewer = viewer; // test hook
		// no hover preselect while the camera is moving (orbit, pan, zoom, view cube)
		viewer.on('moving', (on: boolean) => ((camMoving = on), on && onLeave()));
		viewer.on('poses', () => poses++);
		if (dev) stopFps = trackFps(viewer);
		// re-apply any results that arrived before the viewer existed
		ws.sync();
	});
	onDestroy(() => {
		clearTimeout(hoverTimer);
		stopFps?.();
		window.removeEventListener('keydown', onTab);
		window.removeEventListener('wheel', noPageZoom);
		window.removeEventListener('gesturestart', noPageZoom);
		stopOverlayNav?.();
		ws.detachViewer();
		viewer?.dispose();
	});

	// theme
	$effect(() => {
		const d = dark;
		viewer?.setTheme(viewerTheme(d));
		ws.untracked(() => ws.retheme(d));
	});
	// parts an agent is working on shimmer (from its claimed notes' targets or the file it's writing)
	$effect(() => {
		const working = new Set<string>();
		for (const a of ws.agents) {
			if (a.status !== 'working' && a.status !== 'writing') continue;
			const d = (a.detail ?? {}) as any;
			if (typeof d.path === 'string') for (const p of ws.parts) if (ws.scriptOf(p) === d.path) working.add(p);
			if (d.noteID) for (const t of ws.notes.find((n) => n.id === d.noteID)?.anchor.targets ?? []) if (t.part) working.add(t.part);
			// a part's copies in assemblies are the same geometry
			for (const p of [...working]) for (const c of ws.copiesOf(p)) working.add(c);
		}
		viewer?.setShimmer([...working]);
	});

	// the active studio's parts (or an assembly's instances) are what the viewer holds
	$effect(() => {
		ws.shownParts;
		if (viewer) ws.untracked(() => ws.showStudio());
	});

	// display state -> viewer
	$effect(() => {
		const m = ws.display;
		viewer?.setDisplayMode(m === 'shaded-edges' ? 'shadedEdges' : m === 'hidden-line' ? 'hiddenLine' : m);
	});
	$effect(() => viewer?.setProjection(ws.ortho));
	// fit once when the first geometry lands
	let fitted = false;
	$effect(() => {
		// wait for every part (not just the first to land) so the fit frames the whole model
		const all = ws.parts.length > 0 && ws.parts.every((p) => ws.results[p] && (!ws.results[p].empty || ws.regen[p] === 'idle'));
		if (all && viewer && !fitted) {
			fitted = true;
			queueMicrotask(() => viewer!.setView('iso', false));
		}
	});
	// documents-list thumbnail, once the geometry of a new version settles
	$effect(() => {
		if (viewer) ws.refreshThumbnail();
	});
	$effect(() => {
		ws.selection;
		measureSelection();
	});

	function pickAt(e: PointerEvent | MouseEvent): EntityRef | null {
		if (!viewer) return null;
		const r = host.getBoundingClientRect();
		return viewer.pick(e.clientX - r.left, e.clientY - r.top);
	}

	// ---- pencil (§8 Pencil): strokes project onto the surface under the pen; off the model they
	// continue on a plane at the depth of the last hit. Stored in part-local (= world) coordinates.
	let stroke: { points: [number, number, number][]; part: string | null; plane: THREE.Plane | null; crossed: DraftTarget[]; seen: Set<string> } | null = null;

	function penPoint(e: PointerEvent): { p: THREE.Vector3; ref: ReturnType<Viewer['pickPoint']> } | null {
		const r = host.getBoundingClientRect();
		const x = e.clientX - r.left,
			y = e.clientY - r.top;
		const hit = viewer!.pickPoint(x, y);
		const bounds = viewer!.bounds().getBoundingSphere(new THREE.Sphere()).radius || 10;
		if (hit) {
			const n = hit.normal ?? new THREE.Vector3(0, 0, 1);
			const cam = viewer!.camera.position.clone().sub(hit.point).normalize();
			if (n.dot(cam) < 0) n.negate();
			const p = hit.point.clone().addScaledVector(n, bounds * 0.004);
			if (stroke) stroke.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(viewer!.camera.getWorldDirection(new THREE.Vector3()).negate(), p);
			return { p, ref: hit };
		}
		if (!stroke?.plane) return null;
		const hitP = viewer!.rayAt(x, y).intersectPlane(stroke.plane, new THREE.Vector3());
		return hitP ? { p: hitP, ref: null } : null;
	}

	function eraseAt(e: PointerEvent) {
		const r = host.getBoundingClientRect();
		const x = e.clientX - r.left,
			y = e.clientY - r.top;
		let best: { id: string; d: number } | null = null;
		for (const s of nc.strokes.filter((s) => !s.noteID)) {
			for (const pt of s.points) {
				const sp = viewer!.project(viewer!.toWorld(s.part, new THREE.Vector3(...pt)));
				if (!sp) continue;
				const d = Math.hypot(sp.x - x, sp.y - y);
				if (d < 10 && (!best || d < best.d)) best = { id: s.id, d };
			}
		}
		if (best) {
			ws.mutate(mutators.markup.remove({ id: best.id }), 'Erase stroke');
		}
	}

	function onMove(e: PointerEvent) {
		if (arrowDrag) return sectionArrowMove(e);
		if (partDrag && e.buttons & 1 && viewer) {
			if (!partDrag.started) {
				if (Math.hypot(e.clientX - partDrag.x, e.clientY - partDrag.y) <= 4) return;
				if (!ws.asm.startDrag(partDrag.part, partDrag.local)) return void ((partDrag = null), (host.style.cursor = ''));
				partDrag.started = true;
				host.setPointerCapture(e.pointerId);
				onLeave();
			}
			const r = host.getBoundingClientRect();
			const hit = viewer.rayAt(e.clientX - r.left, e.clientY - r.top).intersectPlane(partDrag.plane, new THREE.Vector3());
			if (hit) ws.asm.dragTo([hit.x, hit.y, hit.z]);
			return;
		}
		if (stroke && e.buttons & 1) {
			// the browser merges moves into one event per frame: take every sub-sample, so a slow
			// frame doesn't flatten a stroke
			const samples = (e.getCoalescedEvents?.() ?? []).length ? e.getCoalescedEvents() : [e];
			for (const ev of samples) addPenSample(ev);
			renderMarkup();
			return;
		}
		strokeless(e);
	}

	function addPenSample(e: PointerEvent) {
		if (!stroke) return;
		{
			const pp = penPoint(e);
			if (pp) {
				const last = stroke.points[stroke.points.length - 1];
				if (!last || pp.p.distanceToSquared(new THREE.Vector3(...last)) > 1e-12) stroke.points.push([pp.p.x, pp.p.y, pp.p.z]);
				if (pp.ref) {
					stroke.part ??= pp.ref.part;
					const k = `${pp.ref.part}:${pp.ref.kind}:${pp.ref.index}`;
					if (!stroke.seen.has(k)) (stroke.seen.add(k), stroke.crossed.push({ ref: { part: pp.ref.part, kind: pp.ref.kind, index: pp.ref.index }, point: [pp.ref.point.x, pp.ref.point.y, pp.ref.point.z], normal: pp.ref.normal ? [pp.ref.normal.x, pp.ref.normal.y, pp.ref.normal.z] : undefined }));
				}
			}
		}
	}

	function strokeless(e: PointerEvent) {
		const rr = host.getBoundingClientRect();
		pointer = { x: e.clientX - rr.left, y: e.clientY - rr.top };
		if (down && down.button === 0 && ws.tool === 'select' && e.buttons & 1 && !box && !partDrag && !e.altKey && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) {
			box = { x0: down.x - rr.left, y0: down.y - rr.top, x1: pointer.x, y1: pointer.y };
		}
		if (box) {
			box = { ...box, x1: pointer.x, y1: pointer.y };
			return;
		}
		if (!viewer || e.buttons || camMoving) return;
		const onArrow = !!ws.section && ws.tool !== 'pencil' && viewer.sectionArrowAt(pointer.x, pointer.y);
		viewer.setSectionArrowHover(onArrow);
		if (onArrow) {
			host.style.cursor = 'grab';
			return onLeave();
		}
		stack = null;
		if (ws.tool === 'pencil') return viewer.setPreselect(null);
		const ref = pickAt(e);
		host.style.cursor = ws.tool === 'select' && ref && ws.asm.movable(ref.part) ? 'grab' : '';
		const h = ws.hover;
		if (ref && h && ref.part === h.part && ref.kind === h.kind && ref.index === h.index) return clearTimeout(hoverTimer);
		clearTimeout(hoverTimer);
		// moving between entities preselects at once; coming onto the model from empty space waits
		// for the pointer to linger briefly, so sweeping across the view stays calm
		if (ref && h) {
			ws.hover = ref;
			viewer.setPreselect(ref);
			return;
		}
		ws.hover = null;
		viewer.setPreselect(null);
		if (ref) hoverTimer = setTimeout(() => ((ws.hover = ref), viewer?.setPreselect(ref)), HOVER_DELAY);
	}

	function onLeave() {
		clearTimeout(hoverTimer);
		ws.hover = null;
		viewer?.setPreselect(null);
	}

	function onDown(e: PointerEvent) {
		down = { x: e.clientX, y: e.clientY, button: e.button };
		if (sectionArrowDown(e)) return;
		if (ws.tool === 'pencil' && e.button === 0 && viewer) {
			if (nc.eraser) return eraseAt(e);
			const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(viewer.camera.getWorldDirection(new THREE.Vector3()).negate(), viewer.controls.target);
			stroke = { points: [], part: null, plane, crossed: [], seen: new Set() };
			nc.holdComposer();
			host.setPointerCapture(e.pointerId);
			addPenSample(e);
			renderMarkup();
			return;
		}
		if (ws.tool === 'select' && e.button === 0 && viewer && !e.altKey && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
			const r = host.getBoundingClientRect();
			const hit = viewer.pickPoint(e.clientX - r.left, e.clientY - r.top);
			if (hit?.local && ws.asm.movable(hit.part)) {
				const facing = viewer.camera.getWorldDirection(new THREE.Vector3()).negate();
				partDrag = { part: hit.part, local: [hit.local.x, hit.local.y, hit.local.z], plane: new THREE.Plane().setFromNormalAndCoplanarPoint(facing, hit.point), x: e.clientX, y: e.clientY, started: false };
				host.style.cursor = 'grabbing';
			}
		}
		// right-click targets the context menu (a Tab-cycled preselection wins, as for a click); it selects on release
		if (e.button === 2) ctxTarget = stack && ws.hover ? ws.hover : pickAt(e);
	}

	async function onUp(e: PointerEvent) {
		if (arrowDrag && e.button === 0) return sectionArrowUp(e);
		if (partDrag && e.button === 0) {
			const d = partDrag;
			partDrag = null;
			host.style.cursor = 'grab';
			if (d.started) {
				down = null;
				host.releasePointerCapture?.(e.pointerId);
				await ws.asm.endDrag();
				return;
			}
		}
		if (stroke) {
			addPenSample(e);
			const s = stroke;
			stroke = null;
			down = null;
			host.releasePointerCapture(e.pointerId);
			if (!s.points.length) return renderMarkup();
			// Marks beside the model still belong to the current part; they needn't cross a face.
			if (!s.part) {
				s.part = nc.draft?.targets.find((t) => ws.shownParts.includes(t.ref.part))?.ref.part ?? ws.shownParts[0];
				if (!s.part) return renderMarkup();
				s.crossed.push({ ref: { part: s.part, kind: 'part' as any, index: 0 }, point: s.points[0] });
			}
			// stored in the part's coordinates, so the stroke moves with it in an assembly
			const part = s.part;
			s.points = s.points.map((p) => viewer!.toLocal(part, new THREE.Vector3(...p)).toArray() as [number, number, number]);
			s.crossed = s.crossed.map((t) => localTarget(t));
			const id = newID();
			const r = host.getBoundingClientRect();
			ws.mutate(mutators.markup.add({ id, documentID: ws.documentID, part: s.part, points: s.points, color: nc.penColor, width: 3 }), 'Draw stroke');
			nc.addStrokeToDraft(id, s.crossed, { x: e.clientX - r.left, y: e.clientY - r.top });
			return;
		}
		if (box && viewer) {
			const b = box;
			box = null;
			down = null;
			const refs = viewer.pickRect(b.x0, b.y0, b.x1, b.y1, b.x1 >= b.x0 ? 'window' : 'crossing');
			ws.select(refs, ws.selectionMode(e, 'add'));
			return;
		}
		if (!down || e.button !== 0 || down.button !== 0) return;
		const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4;
		down = null;
		if (moved || !viewer) return;
		if (ws.tool === 'note') {
			const r = host.getBoundingClientRect();
			const x = e.clientX - r.left,
				y = e.clientY - r.top;
			const edge = viewer.pick(x, y);
			const hit = viewer.pickPoint(x, y);
			const ref = edge?.kind === 'edge' ? edge : hit;
			if (!ref) return;
			const point = hit?.point ?? viewer.entityCenter(ref)!;
			const targets: DraftTarget[] = [localTarget({ ref: { part: ref.part, kind: ref.kind, index: ref.index }, point: [point.x, point.y, point.z], normal: hit?.normal ? [hit.normal.x, hit.normal.y, hit.normal.z] : undefined })];
			if (nc.reanchoring) return void nc.reanchor(nc.reanchoring, targets[0]);
			// shift adds to the draft's targets (a note can point at many entities)
			const all = e.shiftKey && nc.draft ? [...nc.draft.targets, ...targets] : targets;
			nc.startFromTargets(all, { x, y });
			ws.select(all.map((t) => t.ref));
			return;
		}
		// a Tab-cycled preselection is what a click selects
		const ref = stack && ws.hover ? ws.hover : pickAt(e);
		if (ws.tool === 'select' || ws.tool === 'measure') {
			if (!ref) return !(e.shiftKey || e.metaKey || e.ctrlKey) && ws.clearSelection();
			ws.select([ref], ws.tool === 'measure' ? 'toggle' : ws.selectionMode(e));
			if (ws.tool === 'measure' && ws.selection.length > 2) ws.select(ws.selection.slice(-2));
		}
	}

	/** Double-click selects the whole part (body) under the cursor, like Shapr3D. */
	function onDblClick(e: MouseEvent) {
		if (ws.tool !== 'select' || e.button !== 0) return;
		const ref = pickAt(e);
		if (!ref) return;
		const part = { part: ref.part, kind: 'part' as any, index: 0 };
		// Promote this body's faces/edges to the whole part while retaining other bodies.
		const others = ws.selectionMode(e, 'add') === 'add' ? ws.selection.filter((s) => s.part !== ref.part) : [];
		ws.select([...others, part]);
	}

	// ---- measurement card: fixed bottom right, every value named (§8 Selection label) ----
	/** Readouts for a two-entity selection (async: the kernel measures the minimum distance). */
	let pair = $state.raw<Readout[]>([]);
	const readouts = $derived(ws.selection.length === 2 ? pair : singleReadouts(ws.selection, ws.results));
	/** Which readout's dimension line is drawn: the pinned one, or the row under the pointer. */
	let pinned = $state<string | null>(null);
	let peek = $state<string | null>(null);
	const shown = $derived(readouts.find((r) => r.key === peek && r.a) ?? readouts.find((r) => r.key === pinned && r.a) ?? readouts.find((r) => r.a) ?? null);
	$effect(() => {
		const r = shown;
		viewer?.setDimension(r?.a ? new THREE.Vector3(...r.a) : null, r?.b ? new THREE.Vector3(...r.b) : undefined);
	});

	async function measureSelection() {
		pair = [];
		peek = null;
		const sel = ws.selection;
		if (sel.length !== 2 || !ws.engine || !ws.kernelReady) return;
		try {
			const m = await ws.engine.measure(sel[0] as any, sel[1] as any);
			if (ws.selection !== sel) return;
			pair = pairReadouts(sel, m, ws.results, (part, v, dir) => {
				const t = viewer?.partTransform(part);
				if (!t) return v;
				const w = new THREE.Vector3(...v);
				return (dir ? w.transformDirection(t) : w.applyMatrix4(t)).toArray() as [number, number, number];
			});
			// when "distance" is ambiguous (two holes), lead with center to center
			pinned = pair.some((r) => r.key === 'center') ? 'center' : 'min';
		} catch {}
	}
	function noteMeasurement() {
		if (ws.selection.length !== 2 || !shown?.a || !shown.b) return;
		const angle = readouts.find((r) => r.key === 'angle');
		const text = `${shown.label} ${shown.value} ${shown.unit}${angle ? `, ${angle.value}°` : ''}: `;
		const a = new THREE.Vector3(...shown.a),
			b = new THREE.Vector3(...shown.b);
		const targets = ws.selection.map((ref, i) => localTarget({ ref, point: (i ? shown.b : shown.a) as [number, number, number] }));
		nc.startFromTargets(targets, viewer?.project(a.add(b).multiplyScalar(0.5)) ?? { x: 200, y: 200 }, text);
	}

	// ---- section view (S) ----
	/** Bumped when the viewer moves a part, so the section range follows assembly poses. */
	let poses = $state(0);
	/** World-space corners of every shown part's bbox (instances placed by their transforms). */
	const sectionCorners = $derived.by(() => {
		void poses;
		return ws.shownParts.flatMap((id) => {
			const b = ws.results[sourcePart(id)]?.bbox;
			if (!b) return [];
			const m = viewer?.partTransform(id);
			return [0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
				const v = new THREE.Vector3(i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]);
				return m ? v.applyMatrix4(m) : v;
			});
		});
	});
	function axisCenter(axis: 'X' | 'Y' | 'Z') {
		const k = { X: 0, Y: 1, Z: 2 }[axis];
		const c = sectionCorners.map((v) => v.getComponent(k));
		return c.length ? (Math.min(...c) + Math.max(...c)) / 2 : 0;
	}
	const sectionRange = $derived.by(() => {
		const s = ws.section;
		if (!sectionCorners.length || !s) return { min: -50, max: 50 };
		// signed distance of every corner along the section direction, from its offset-0 point
		const { origin, dir } = sectionBase(s);
		const ds = sectionCorners.map((v) => (v.x - origin[0]) * dir[0] + (v.y - origin[1]) * dir[1] + (v.z - origin[2]) * dir[2]);
		return s.axis === 'Face' ? { min: Math.min(...ds, 0), max: Math.max(...ds, 0) } : { min: Math.min(...ds), max: Math.max(...ds) };
	});
	// Explicit endpoints avoid floating-point step rounding stopping short of the model bounds.
	const sectionSteps = $derived(Array.from({ length: 201 }, (_, i) => i === 200 ? sectionRange.max : sectionRange.min + (sectionRange.max - sectionRange.min) * i / 200));
	/** The section's unflipped direction (offset runs along it) and the point at offset 0. */
	function sectionBase(s: NonNullable<typeof ws.section>) {
		if (s.axis === 'Face' && s.plane) return { origin: s.plane.origin, dir: s.plane.normal };
		return { origin: [0, 0, 0], dir: s.axis === 'X' ? [1, 0, 0] : s.axis === 'Y' ? [0, 1, 0] : [0, 0, 1] };
	}
	$effect(() => {
		const s = ws.section;
		if (!viewer) return;
		if (!s) return viewer.setSectionArrowHover(false), viewer.setSection(null);
		const { origin, dir } = sectionBase(s);
		// Bias inward to avoid z-fighting at a cut, but outward at the fully retained endpoint
		// so the outer face stays intact instead of becoming a thin, hatched section.
		const eps = Math.max(viewer.bounds().getSize(new THREE.Vector3()).length() * 1e-5, 1e-6);
		const fullyRetained = s.flip ? s.offset <= sectionRange.min : s.offset >= sectionRange.max;
		const d = s.offset + (s.flip ? eps : -eps) * (fullyRetained ? -1 : 1);
		viewer.setSection({ origin: origin.map((c, k) => c + dir[k] * d), normal: s.flip ? dir.map((c) => -c) : dir });
		ws.untracked(() => ws.rememberSection());
	});

	/**
	 * Section arrow: drag it along its axis to move the plane, click it to flip. `t0` is where it was
	 * grabbed along the axis, relative to the plane.
	 */
	let arrowDrag: { t0: number; x: number; y: number; moved: boolean } | null = null;
	function sectionArrowDown(e: PointerEvent): boolean {
		if (!viewer || !ws.section || ws.tool === 'pencil' || e.button !== 0 || e.altKey) return false;
		const r = host.getBoundingClientRect();
		const x = e.clientX - r.left,
			y = e.clientY - r.top;
		if (!viewer.sectionArrowAt(x, y)) return false;
		arrowDrag = { t0: viewer.sectionAxisAt(x, y) ?? 0, x: e.clientX, y: e.clientY, moved: false };
		// the controls listen on the canvas below: they never see this press
		e.stopPropagation();
		host.setPointerCapture(e.pointerId);
		host.style.cursor = 'grabbing';
		onLeave();
		return true;
	}
	function sectionArrowMove(e: PointerEvent) {
		const d = arrowDrag!,
			s = ws.section;
		if (!viewer || !s) return;
		if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) <= 3) return;
		d.moved = true;
		const r = host.getBoundingClientRect();
		const t = viewer.sectionAxisAt(e.clientX - r.left, e.clientY - r.top);
		if (t === null) return;
		// the drag axis (kept side) runs against the offset direction unless flipped
		const offset = s.offset + (t - d.t0) * (s.flip ? 1 : -1);
		ws.section = { ...s, offset: Math.min(sectionRange.max, Math.max(sectionRange.min, offset)) };
	}
	function sectionArrowUp(e: PointerEvent) {
		const d = arrowDrag!;
		arrowDrag = null;
		down = null;
		host.releasePointerCapture?.(e.pointerId);
		host.style.cursor = 'grab';
		if (!d.moved && ws.section) ws.section = { ...ws.section, flip: !ws.section.flip };
	}
	$effect(() => viewer?.setHelpers({ grid: ws.showGrid, origin: ws.showOrigin }));
	$effect(() => viewer?.setOverlapsOnTop(ws.asm.interferenceOnTop));

	// ---- markup: drafts, open notes' strokes, and the hovered note's (§8 Pencil) ----
	function markupFor() {
		const open = new Set(ws.notes.filter((n) => n.status !== 'Resolved' && !n.removedAt).map((n) => n.id));
		return nc.strokes
			.filter((s) => !s.noteID || open.has(s.noteID) || nc.hovered === s.noteID)
			.map((s) => ({ id: s.id, points: s.points, color: s.color, width: s.width, part: s.part, dim: !!s.noteID && nc.hovered !== null && nc.hovered !== s.noteID }));
	}

	/** Note targets are stored in part coordinates (assembly parts move; the anchor moves with them). */
	function localTarget(t: DraftTarget): DraftTarget {
		if (!viewer) return t;
		const p = viewer.toLocal(t.ref.part, new THREE.Vector3(...t.point));
		const n = t.normal ? viewer.toLocal(t.ref.part, new THREE.Vector3(...t.point).add(new THREE.Vector3(...t.normal))).sub(p).normalize() : undefined;
		return { ...t, point: p.toArray() as [number, number, number], normal: n?.toArray() as [number, number, number] | undefined };
	}
	function renderMarkup() {
		const marks: Parameters<Viewer['setMarkup']>[0] = markupFor();
		if (stroke) marks.push({ id: 'live', points: stroke.points, color: nc.penColor, width: 3, part: undefined, dim: false });
		viewer?.setMarkup(marks);
	}
	$effect(() => {
		nc.strokes;
		nc.hovered;
		ws.notes;
		renderMarkup();
	});
	// hovering a thread highlights its geometry (§6 UX)
	$effect(() => {
		const id = nc.hovered;
		const n = id ? ws.notes.find((x) => x.id === id) : null;
		if (!n) return ws.untracked(() => viewer?.setSelection(ws.selection));
		nc.targetRefs(n).then((refs) => nc.hovered === id && viewer?.setSelection([...ws.selection, ...refs]));
	});

	// ---- status pill: calm, agents fix errors (§8 Errors) ----
	const failing = $derived(ws.partResults.filter((r) => r.problems.some((p) => p.severity === 'error')));
	const warnings = $derived(ws.partResults.filter((r) => !r.problems.some((p) => p.severity === 'error') && r.problems.length));
	const pill = $derived.by(() => {
		// the engine failing to load used to show only in Properties; say it where people look
		if (ws.engineError) return { tone: 'error' as const, title: "Couldn't load the model", detail: 'reload the page', message: undefined, source: undefined, file: undefined, line: undefined };
		if (failing.length) {
			const r = failing[0];
			const p = r.problems.find((x) => x.severity === 'error')!;
			return {
				tone: 'error' as const,
				title: failing.length === 1 ? `${r.name} didn't regenerate` : `${failing.length} parts didn't regenerate`,
				detail: ws.agents.some((a) => a.status !== 'disconnected') ? undefined : 'showing last good geometry',
				message: p.message,
				source: p.source ? `${p.source.file.split('/').pop()}:${p.source.line}` : undefined,
				file: p.source?.file,
				line: p.source?.line
			};
		}
		const ap = ws.asm.problems[0];
		if (ap) {
			const name = ws.asm.assemblies.find((a) => a.id === ap.assembly)?.name ?? ap.assembly;
			return { tone: 'error' as const, title: `${name}: joints need a fix`, detail: ws.asm.problems.length > 1 ? `${ws.asm.problems.length} problems` : '', message: ap.message, source: ap.source ? `${ap.source.file.split('/').pop()}:${ap.source.line}` : undefined, file: ap.source?.file, line: ap.source?.line };
		}
		if (warnings.length) {
			const r = warnings[0];
			const p = r.problems[0];
			return { tone: 'warning' as const, title: `${r.name}: ${warnings.reduce((n, w) => n + w.problems.length, 0)} warning${warnings.length > 1 || r.problems.length > 1 ? 's' : ''}`, detail: '', message: p.message, source: p.source ? `${p.source.file.split('/').pop()}:${p.source.line}` : undefined, file: p.source?.file, line: p.source?.line };
		}
		return null;
	});

	function revealSource(file?: string, line?: number) {
		if (!file) return;
		ws.openScript = file;
		ws.revealLine = line ?? null;
		ws.mode = 'code';
	}

	// an engine that failed to load shows its error in the status pill, not an endless loader
	const busy = $derived((!ws.kernelReady && !ws.engineError) ||Object.values(ws.regen).some((s) => s !== 'idle'));
	const empty = $derived(ws.synced && ws.parts.length === 0);
	/** Veils the canvas behind the empty and loading states. */
	const scrim = 'absolute inset-0 grid place-items-center bg-[radial-gradient(closest-side,var(--bg-canvas)_35%,color-mix(in_oklab,var(--bg-canvas)_60%,transparent))] backdrop-blur-[3px]';
	const neverGenerated = $derived(ws.synced && ws.parts.length > 0 && !Object.values(ws.results).some((r) => !r.empty));

	const ctxItems = $derived.by<MenuEntry[]>(() => {
		const t = ctxTarget;
		const sel = ws.selection;
		const items: MenuEntry[] = [];
		const target = t ?? sel[0];
		if (target && target.kind !== ('part' as any)) {
			items.push({
				label: 'Select all from this operation',
				icon: Layers,
				disabled: !ws.kernelReady,
				onSelect: async () => {
					const d = await ws.engine!.describe(target.part, target.kind, target.index);
					if (!d.createdBy) return;
					const groups = await ws.engine!.fromOperation(target.part, d.createdBy.id);
					ws.select(groups.flatMap((g) => g.indices.map((index) => ({ part: target.part, kind: g.kind, index }))).filter((r) => r.kind === target.kind));
				}
			});
		}
		if (target?.kind === 'edge') {
			items.push({
				label: 'Select tangent chain',
				disabled: !ws.kernelReady,
				onSelect: async () => ws.select((await ws.engine!.tangentChain(target.part, target.index)).map((index) => ({ part: target.part, kind: 'edge' as const, index })))
			});
			items.push({
				label: 'Select loop',
				disabled: !ws.kernelReady,
				onSelect: async () => ws.select((await ws.engine!.loopOf(target.part, target.index)).map((index) => ({ part: target.part, kind: 'edge' as const, index })))
			});
		} else if (target?.kind === 'face') {
			items.push({
				label: 'Select boundary loop',
				icon: SquareDashed,
				disabled: !ws.kernelReady,
				onSelect: async () => {
					const edges = ws.results[target.part]?.faceEdges[target.index] ?? [];
					if (!edges.length) return;
					ws.select((await ws.engine!.loopOf(target.part, edges[0], target.index)).map((index) => ({ part: target.part, kind: 'edge' as const, index })));
				}
			});
			const plane = viewer?.facePlane(target) ?? null;
			items.push({ label: 'Section view', icon: Scissors, disabled: !plane, onSelect: () => plane && ws.sectionFromFace(plane) });
		}
		if (items.length) items.push({ type: 'separator' });
		if (target) {
			items.push({ label: 'Hide part', icon: EyeOff, onSelect: () => ws.setHidden(target.part, true) });
		}
		if (target && target.kind !== ('part' as any)) {
			items.push({ type: 'separator' });
			items.push({
				label: 'Copy reference',
				icon: Copy,
				onSelect: async () => {
					const r = ws.results[target.part];
					const name = r?.names?.[target.kind as 'face' | 'edge']?.[target.index] ?? (ws.kernelReady ? (await ws.engine!.describe(target.part, target.kind, target.index)).name : null);
					if (name) {
						await navigator.clipboard.writeText(name);
						toast('Copied');
					}
				}
			});
		}
		return items;
	});
</script>

<ContextMenu items={ctxItems} class="relative min-h-0 flex-1 overflow-hidden">
	<div
		class="absolute inset-0 overflow-hidden bg-canvas"
		bind:this={host}
		onpointermove={onMove}
		onpointerleave={() => (onLeave(), viewer?.setSectionArrowHover(false))}
		onpointerdowncapture={onDown}
		onpointerup={onUp}
		ondblclick={onDblClick}
		data-testid="viewport"
		role="application"
		aria-label="3D viewport"
	></div>

	<ProgressLine active={busy} label={!ws.kernelReady ? 'Loading' : 'Regenerating'} class="absolute inset-x-0 top-0 z-10" />

	<div class="pointer-events-none absolute top-3 left-3 z-10 flex max-w-[calc(100%-140px)] flex-col items-start gap-1.5 *:pointer-events-auto">
		{#if ws.dirty.length}
			<div data-testid="unsaved-preview" in:rise={{ y: -4, scale: 0.97, origin: 'top left' }} out:fadeOut>
				<StatusPill tone="preview" title="Unsaved preview" detail="⌘S to save" />
			</div>
		{/if}
		{#if pill}
			<div class="max-w-[520px]" in:rise={{ y: -4, scale: 0.97, origin: 'top left' }} out:fadeOut>
				<StatusPill tone={pill.tone} title={pill.title} detail={pill.detail} message={pill.message} source={pill.source} bind:expanded={pillOpen} onClick={ws.engineError ? () => window.location.reload() : undefined} onSourceClick={() => revealSource(pill!.file, pill!.line)} />
			</div>
		{/if}
	</div>

	{#if ws.mode === 'model'}
		<div class="absolute top-[120px] right-[33px] z-10">
			<ViewportControls bind:display={() => ws.display, (v) => (ws.display = v)} bind:ortho={() => ws.ortho, (v) => (ws.ortho = v)} bind:section={() => !!ws.section, (v) => { if (v !== !!ws.section) ws.toggleSection(); }} bind:grid={() => ws.showGrid, (v) => ws.setHelpers({ grid: v })} bind:origin={() => ws.showOrigin, (v) => ws.setHelpers({ origin: v })} bind:overlapsOnTop={() => ws.asm.interferenceOnTop, (v) => ws.asm.setInterferenceOnTop(v)} orientation="vertical" onZoomToFit={() => viewer?.fitOrHome()} />
		</div>
	{/if}

	{#if box}
		<div
			class="pointer-events-none absolute z-20 border {box.x1 >= box.x0 ? 'border-accent bg-accent/8' : 'border-dashed border-accent bg-accent/5'}"
			style="left:{Math.min(box.x0, box.x1)}px;top:{Math.min(box.y0, box.y1)}px;width:{Math.abs(box.x1 - box.x0)}px;height:{Math.abs(box.y1 - box.y0)}px"
			data-testid="box-select"
		></div>
	{/if}
	{#if ws.section}
		<div class="absolute top-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-[var(--toolbar-radius)] bg-elevated p-[var(--toolbar-pad)] pl-3 shadow-toolbar" data-testid="section-bar" in:pop={{ origin: 'top center' }} out:popOut>
			<span class="text-ui font-medium">Section</span>
			<!-- a section through a slanted face has no axis: none is selected -->
			<SegmentedControl value={ws.section.axis} items={[{ value: 'X', text: 'X' }, { value: 'Y', text: 'Y' }, { value: 'Z', text: 'Z' }]} onValueChange={(v) => (ws.section = { axis: v as 'X' | 'Y' | 'Z', flip: ws.section!.flip, offset: axisCenter(v as 'X' | 'Y' | 'Z') })} class="w-28" />
			<Slider value={ws.section.offset} min={sectionRange.min} max={sectionRange.max} step={sectionSteps} onValueChange={(v: number) => (ws.section = { ...ws.section!, offset: v })} class="w-40" aria-label="Section offset" />
			<span class="w-16 text-label text-fg-secondary tabular-nums">{num(ws.section.offset, 1)} mm</span>
			<IconButton label="Flip" size="sm" onclick={() => (ws.section = { ...ws.section!, flip: !ws.section!.flip })}><FlipVertical2 /></IconButton>
			<IconButton label="Close section" shortcut={['S']} size="sm" onclick={() => (ws.section = null)}><X /></IconButton>
		</div>
	{/if}

	{#if readouts.length}
		<div class="absolute right-3 bottom-3 z-20 flex min-w-52 flex-col rounded-[var(--toolbar-radius)] bg-elevated p-[var(--toolbar-pad)] shadow-toolbar" data-testid="measure-card" in:rise={{ y: 4, scale: 0.98, origin: '100% 100%' }} out:fadeOut>
			{#each readouts as r (r.key)}
				{@const on = shown?.key === r.key}
				{#if r.a}
					<button
						class="focus-ring flex h-7 items-center gap-2 rounded-[var(--toolbar-item-radius)] px-2 text-left transition-colors-fast {on ? 'bg-active' : 'hover:bg-hover'}"
						onclick={() => (pinned = r.key)}
						onpointerenter={() => (peek = r.key)}
						onpointerleave={() => (peek = null)}
						aria-pressed={pinned === r.key}
						title="Show this dimension"
					>
						<span class="size-1.5 shrink-0 rounded-full {on ? 'bg-accent' : 'bg-fg-tertiary/40'}"></span>
						<span class="flex-1 text-label {on ? 'text-fg' : 'text-fg-secondary'}">{r.label}</span>
						<span class="text-ui font-medium tabular-nums">{r.value}<span class="ml-0.5 text-label font-normal text-fg-secondary">{r.unit}</span></span>
					</button>
				{:else}
					<div class="flex h-7 items-center gap-2 px-2">
						<span class="size-1.5 shrink-0"></span>
						<span class="flex-1 text-label text-fg-secondary">{r.label}</span>
						<span class="text-ui font-medium tabular-nums">{r.value}{#if r.unit}<span class="ml-0.5 text-label font-normal text-fg-secondary">{r.unit}</span>{/if}</span>
					</div>
				{/if}
			{/each}
			{#if ws.selection.length === 2 && shown}
				<div class="mt-1 border-t border-line-subtle pt-1">
					<Button size="sm" variant="ghost" class="w-full justify-start" onclick={noteMeasurement}><MessageCircle size={14} /> Note</Button>
				</div>
			{/if}
		</div>
	{/if}

	{#if empty}
		<div class="{scrim} z-10" data-testid="empty-document">
			<EmptyState size="panel" class="animate-enter" title="No parts yet">
				{#snippet action()}
					<div class="flex gap-2">
						<Button variant="primary" onclick={onAddStudio} data-testid="add-studio"><Plus size={14} /> Add a studio</Button>
						<Button onclick={onConnect}><Bot size={14} /> Connect an agent</Button>
					</div>
				{/snippet}
			</EmptyState>
		</div>
	{:else if neverGenerated && !Object.values(ws.regen).some((s) => s === 'running')}
		<div class="{scrim} pointer-events-none z-0 text-fg-tertiary" out:fadeOut>
			<div class="animate-enter flex flex-col items-center gap-2 text-ui"><Box size={28} strokeWidth={1.25} /> Loading…</div>
		</div>
	{/if}

	{#if viewer}
		<Pins {ws} {viewer} {nc} onopen={onOpenNote} />
	{/if}
	{#if nc.draft && nc.composerShown}
		<div class="absolute z-20" in:rise={{ y: 4, scale: 0.96, origin: 'top left' }} out:fadeOut style="left:{Math.max(8, Math.min(nc.draft.screen.x + 12, (host?.clientWidth ?? 800) - 292))}px;top:{Math.max(8, Math.min(nc.draft.screen.y - 20, (host?.clientHeight ?? 600) - 140))}px">
			<NoteComposer {ws} {nc} />
		</div>
	{/if}

	{#if dev && fps}
		<div class="pointer-events-none absolute bottom-3 left-3 z-10 rounded-sm bg-elevated/80 px-1.5 py-0.5 font-mono text-label text-fg-tertiary tabular-nums" data-testid="fps">
			{fps.fps} fps · {fps.ms.toFixed(1)} ms
		</div>
	{/if}

	<div class="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-2">
		{#if ws.tool === 'pencil'}
			<div class="flex items-center gap-0.5 rounded-[var(--toolbar-radius)] bg-elevated p-[var(--toolbar-pad)] shadow-toolbar" data-testid="pencil-options" in:rise={{ y: 8, scale: 0.97, duration: 200, origin: '50% 100%' }} out:rise={{ y: 4, scale: 0.98, duration: 100 }}>
				{#each STROKE_COLORS as c (c)}
					{@const on = nc.penColor === c && !nc.eraser}
					<button class="focus-ring grid size-8 place-items-center rounded-[var(--toolbar-item-radius)] transition-colors-fast {on ? 'bg-active' : 'hover:bg-hover'}" onclick={() => ((nc.penColor = c), (nc.eraser = false))} aria-label="Pen color {c}" aria-pressed={on}>
						<span class="size-3.5 rounded-full shadow-[inset_0_0_0_1px_var(--border-default)] transition-transform duration-[var(--duration-fast)] ease-out {on ? 'scale-[1.15]' : ''}" style="background:{c}"></span>
					</button>
				{/each}
				<span class="mx-1 h-5 w-px bg-line" aria-hidden="true"></span>
				<button class="focus-ring h-8 rounded-[var(--toolbar-item-radius)] px-2.5 text-ui font-medium transition-colors-fast {nc.eraser ? 'bg-active text-fg' : 'text-fg-secondary hover:bg-hover hover:text-fg'}" onclick={() => (nc.eraser = !nc.eraser)} aria-pressed={nc.eraser}>Eraser</button>
			</div>
		{/if}
		<FloatingToolbar bind:tool={ws.tool} disabled={ws.dirty.length ? { note: 'Save to add notes', pencil: 'Save to draw' } : {}} />
	</div>
</ContextMenu>
