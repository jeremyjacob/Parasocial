<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Crosshair, Copy, EyeOff, Focus, Code2, MessageCircle, Ruler, Layers, Plus, Bot, Box, X, FlipVertical2 } from '@lucide/svelte';
	import { Viewer, type EntityRef } from '@parasocial/viewer';
	import { FloatingToolbar, SelectionLabel, StatusPill, ViewportControls } from '$lib/components/ui/viewport';
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
	import NoteComposer from './NoteComposer.svelte';
	import { rise, fadeOut } from '$lib/styles/motion';

	let { ws, nc, onAddPart, onConnect, onOpenNote }: { ws: WorkspaceState; nc: NotesController; onAddPart: () => void; onConnect: () => void; onOpenNote: (id: string) => void } = $props();

	let host: HTMLDivElement;
	let viewer: Viewer | null = $state.raw(null);
	let labelPos = $state<{ x: number; y: number } | null>(null);
	let measured = $state<string | null>(null);
	let pillOpen = $state(false);
	let ctxTarget = $state.raw<EntityRef | null>(null);
	let down: { x: number; y: number; button: number } | null = null;
	/** Box select: left-drag in the select tool. Left→right = window, right→left = crossing. */
	let box = $state<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
	/** Tab cycles through the faces stacked under the cursor (§8 Selection). */
	let stack: { x: number; y: number; refs: EntityRef[]; i: number } | null = null;
	let pointer: { x: number; y: number } | null = null;
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
		ws.hover = stack.refs[stack.i];
		viewer.setPreselect(ws.hover);
	}

	onMount(() => {
		window.addEventListener('keydown', onTab);
		host.addEventListener('contextmenu', onContextCapture, { capture: true });
		host.addEventListener('pointerup', onRightUp);
		viewer = new Viewer(host, { theme: viewerTheme(dark) });
		ws.viewer = viewer;
		(window as any).__viewer = viewer; // test hook
		viewer.on('camera', updateLabel);
		viewer.on('camera', () => updateDim());
		// re-apply any results that arrived before the viewer existed
		ws.sync();
	});
	onDestroy(() => {
		window.removeEventListener('keydown', onTab);
		viewer?.dispose();
		ws.viewer = null;
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
			if (typeof d.path === 'string' && d.path.startsWith('parts/')) working.add(d.path.slice(6, -3));
			if (d.noteID) for (const t of ws.notes.find((n) => n.id === d.noteID)?.anchor.targets ?? []) if (t.part) working.add(t.part);
		}
		viewer?.setShimmer([...working]);
	});

	// display state -> viewer
	$effect(() => {
		const m = ws.display;
		viewer?.setDisplayMode(m === 'shaded-edges' ? 'shadedEdges' : m === 'hidden-line' ? 'hiddenLine' : m);
	});
	$effect(() => viewer?.setProjection(ws.ortho));
	$effect(() => {
		if (viewer) viewer.filter = { face: ws.filters.includes('face'), edge: ws.filters.includes('edge'), vertex: ws.filters.includes('vertex'), part: ws.filters.includes('part') };
	});
	// fit once when the first geometry lands
	let fitted = false;
	$effect(() => {
		const n = Object.values(ws.results).filter((r) => !r.empty).length;
		if (n && viewer && !fitted) {
			fitted = true;
			queueMicrotask(() => viewer!.setView('iso', false));
		}
	});
	$effect(() => {
		ws.selection;
		updateLabel();
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
				const sp = viewer!.project(new THREE.Vector3(...pt));
				if (!sp) continue;
				const d = Math.hypot(sp.x - x, sp.y - y);
				if (d < 10 && (!best || d < best.d)) best = { id: s.id, d };
			}
		}
		if (best) {
			ws.zero.mutate(mutators.markup.remove({ id: best.id }));
			if (nc.draft) nc.draft = { ...nc.draft, strokeIDs: nc.draft.strokeIDs.filter((i) => i !== best!.id) };
		}
	}

	function onMove(e: PointerEvent) {
		if (stroke && e.buttons & 1) {
			const pp = penPoint(e);
			if (pp) {
				const last = stroke.points[stroke.points.length - 1];
				if (!last || pp.p.distanceTo(new THREE.Vector3(...last)) > 0.05) stroke.points.push([pp.p.x, pp.p.y, pp.p.z]);
				if (pp.ref) {
					stroke.part ??= pp.ref.part;
					const k = `${pp.ref.part}:${pp.ref.kind}:${pp.ref.index}`;
					if (!stroke.seen.has(k)) (stroke.seen.add(k), stroke.crossed.push({ ref: { part: pp.ref.part, kind: pp.ref.kind, index: pp.ref.index }, point: [pp.ref.point.x, pp.ref.point.y, pp.ref.point.z], normal: pp.ref.normal ? [pp.ref.normal.x, pp.ref.normal.y, pp.ref.normal.z] : undefined }));
				}
				viewer!.setMarkup([...markupFor(), { id: 'live', points: stroke.points, color: nc.penColor, width: 3 }]);
			}
			return;
		}
		const rr = host.getBoundingClientRect();
		pointer = { x: e.clientX - rr.left, y: e.clientY - rr.top };
		if (down && down.button === 0 && ws.tool === 'select' && e.buttons & 1 && !box && !e.altKey && !viewer?.controls.spaceHeld && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) {
			box = { x0: down.x - rr.left, y0: down.y - rr.top, x1: pointer.x, y1: pointer.y };
		}
		if (box) {
			box = { ...box, x1: pointer.x, y1: pointer.y };
			return;
		}
		if (!viewer || e.buttons) return;
		stack = null;
		if (ws.tool === 'pencil') return viewer.setPreselect(null);
		const ref = pickAt(e);
		ws.hover = ref;
		viewer.setPreselect(ref);
	}

	function onLeave() {
		ws.hover = null;
		viewer?.setPreselect(null);
	}

	function onDown(e: PointerEvent) {
		down = { x: e.clientX, y: e.clientY, button: e.button };
		if (ws.tool === 'pencil' && e.button === 0 && viewer) {
			if (nc.eraser) return eraseAt(e);
			stroke = { points: [], part: null, plane: null, crossed: [], seen: new Set() };
			host.setPointerCapture(e.pointerId);
			const pp = penPoint(e);
			if (pp) stroke.points.push([pp.p.x, pp.p.y, pp.p.z]);
			return;
		}
		if (e.button === 2) {
			ctxTarget = pickAt(e);
			const t = ctxTarget;
			if (t && !ws.selection.some((s) => s.part === t.part && s.kind === t.kind && s.index === t.index)) ws.select([t]);
		}
	}

	async function onUp(e: PointerEvent) {
		if (stroke) {
			const s = stroke;
			stroke = null;
			if (s.points.length < 2 || !s.part) return renderMarkup();
			const id = newID();
			const r = host.getBoundingClientRect();
			ws.zero.mutate(mutators.markup.add({ id, documentID: ws.documentID, part: s.part, points: s.points, color: nc.penColor, width: 3 }));
			nc.addStrokeToDraft(id, s.crossed, { x: e.clientX - r.left, y: e.clientY - r.top });
			return;
		}
		if (box && viewer) {
			const b = box;
			box = null;
			down = null;
			const refs = viewer.pickRect(b.x0, b.y0, b.x1, b.y1, b.x1 >= b.x0 ? 'window' : 'crossing');
			ws.select(refs, e.shiftKey || e.metaKey || e.ctrlKey ? 'add' : 'replace');
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
			const targets: DraftTarget[] = [{ ref: { part: ref.part, kind: ref.kind, index: ref.index }, point: [point.x, point.y, point.z], normal: hit?.normal ? [hit.normal.x, hit.normal.y, hit.normal.z] : undefined }];
			if (nc.reanchoring) return void nc.reanchor(nc.reanchoring, targets[0]);
			// shift adds to the draft's targets (a note can point at many entities)
			if (e.shiftKey && nc.draft) nc.startFromTargets([...nc.draft.targets, ...targets], { x, y });
			else nc.startFromTargets(targets, { x, y });
			return;
		}
		// a Tab-cycled preselection is what a click selects
		const ref = stack && ws.hover ? ws.hover : pickAt(e);
		if (ws.tool === 'select' || ws.tool === 'measure') {
			if (!ref) return !(e.shiftKey || e.metaKey || e.ctrlKey) && ws.clearSelection();
			ws.select([ref], e.shiftKey || e.metaKey || e.ctrlKey || ws.tool === 'measure' ? 'toggle' : 'replace');
			if (ws.tool === 'measure' && ws.selection.length > 2) ws.select(ws.selection.slice(-2));
		}
	}

	function updateLabel() {
		const sel = ws.selection;
		if (!viewer || !sel.length) return (labelPos = null);
		const c = viewer.entityCenter(sel[sel.length - 1]);
		const p = c ? viewer.project(c) : null;
		labelPos = p && p.x >= 0 && p.y >= 0 && p.x <= host.clientWidth && p.y <= host.clientHeight - 30 ? p : null;
	}

	/** The single most useful value for the selection (§8 Selection label). */
	const label = $derived.by(() => {
		const sel = ws.selection;
		if (!sel.length) return null;
		if (sel.length === 2 && measured) return { value: measured, unit: '' };
		if (sel.length > 1) {
			const kinds = new Set(sel.map((s) => s.kind));
			return { value: `${sel.length} ${kinds.size === 1 ? [...kinds][0] + 's' : 'items'}`, unit: '' };
		}
		const s = sel[0];
		const r = ws.results[s.part];
		if (!r) return null;
		if (s.kind === 'face') {
			const f = r.faces[s.index];
			return f ? { value: num(f.area, 2), unit: 'mm²' } : null;
		}
		if (s.kind === 'edge') {
			const e = r.edges[s.index];
			if (!e) return null;
			if (e.curve === 'circle' && e.radius) return { value: `R ${num(e.radius, 2)}`, unit: 'mm' };
			return { value: num(e.length, 2), unit: 'mm' };
		}
		return { value: r.name, unit: '' };
	});

	// ---- measure tool (M): a dimension between two entities, "Note this measurement" ----
	let dim = $state.raw<{ a: THREE.Vector3; b: THREE.Vector3; distance: number; angle?: number } | null>(null);
	let dimPos = $state<{ x: number; y: number } | null>(null);

	async function measureSelection() {
		measured = null;
		dim = null;
		viewer?.setDimension(null);
		const sel = ws.selection;
		if (sel.length !== 2 || !ws.engine || !ws.kernelReady) return;
		try {
			const m = await ws.engine.measure(sel[0] as any, sel[1] as any);
			if (ws.selection !== sel) return;
			measured = `${num(m.distance, 2)} mm`;
			if (ws.tool !== 'measure') return;
			let angle: number | undefined;
			const dirOf = (r: any) => (r.kind === 'face' ? (ws.results[r.part]?.faces[r.index]?.surface === 'plane' ? ws.results[r.part]?.faces[r.index]?.normal : undefined) : ws.results[r.part]?.edges[r.index]?.direction);
			const da = dirOf(sel[0]),
				db = dirOf(sel[1]);
			if (da && db) angle = (Math.acos(Math.min(1, Math.abs(da[0] * db[0] + da[1] * db[1] + da[2] * db[2]))) * 180) / Math.PI;
			dim = { a: new THREE.Vector3(...m.a), b: new THREE.Vector3(...m.b), distance: m.distance, angle };
			viewer?.setDimension(dim.a, dim.b);
			updateDim();
		} catch {}
	}
	function updateDim() {
		if (!dim || !viewer) return (dimPos = null);
		dimPos = viewer.project(dim.a.clone().add(dim.b).multiplyScalar(0.5));
	}
	$effect(() => {
		if (ws.tool !== 'measure') {
			dim = null;
			viewer?.setDimension(null);
		}
	});
	function noteMeasurement() {
		if (!dim || ws.selection.length !== 2) return;
		const text = `${num(dim.distance, 2)} mm${dim.angle !== undefined ? `, ${num(dim.angle, 1)}°` : ''}: `;
		const targets = ws.selection.map((ref, i) => ({ ref, point: (i ? dim!.b : dim!.a).toArray() as [number, number, number] }));
		nc.startFromTargets(targets, dimPos ?? { x: 200, y: 200 }, text);
	}

	// ---- section view (S) ----
	const sectionRange = $derived.by(() => {
		const r = Object.values(ws.results).filter((x) => x.bbox);
		if (!r.length || !ws.section) return { min: -50, max: 50 };
		const k = { X: 0, Y: 1, Z: 2 }[ws.section.axis];
		return { min: Math.min(...r.map((x) => x.bbox!.min[k])), max: Math.max(...r.map((x) => x.bbox!.max[k])) };
	});
	$effect(() => {
		const s = ws.section;
		if (!viewer) return;
		if (!s) return viewer.setSection(null);
		const n = s.axis === 'X' ? [1, 0, 0] : s.axis === 'Y' ? [0, 1, 0] : [0, 0, 1];
		const o = n.map((c) => c * s.offset);
		viewer.setSection({ origin: o, normal: s.flip ? n.map((c) => -c) : n });
	});

	// ---- markup: drafts, open notes' strokes, and the hovered note's (§8 Pencil) ----
	function markupFor() {
		const open = new Set(ws.notes.filter((n) => n.status !== 'Resolved' && !n.removedAt).map((n) => n.id));
		return nc.strokes
			.filter((s) => !s.noteID || open.has(s.noteID) || nc.hovered === s.noteID)
			.map((s) => ({ id: s.id, points: s.points, color: s.color, width: s.width, dim: !!s.noteID && nc.hovered !== null && nc.hovered !== s.noteID }));
	}
	function renderMarkup() {
		viewer?.setMarkup(markupFor());
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
	const failing = $derived(Object.values(ws.results).filter((r) => r.problems.some((p) => p.severity === 'error')));
	const warnings = $derived(Object.values(ws.results).filter((r) => !r.problems.some((p) => p.severity === 'error') && r.problems.length));
	const pill = $derived.by(() => {
		// the engine failing to load used to show only in Properties; say it where people look
		if (ws.engineError) return { tone: 'error' as const, title: "Couldn't load the model", detail: 'reload the page', message: undefined, source: undefined, file: undefined, line: undefined };
		if (failing.length) {
			const r = failing[0];
			const p = r.problems.find((x) => x.severity === 'error')!;
			return {
				tone: 'error' as const,
				title: failing.length === 1 ? `${r.name} didn't regenerate` : `${failing.length} parts didn't regenerate`,
				detail: ws.agents.some((a) => a.status !== 'disconnected') ? 'agents notified' : 'showing last good geometry',
				message: p.message,
				source: p.source ? `${p.source.file.split('/').pop()}:${p.source.line}` : undefined,
				file: p.source?.file,
				line: p.source?.line
			};
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

	const busy = $derived(!ws.kernelReady || Object.values(ws.regen).some((s) => s !== 'idle'));
	const empty = $derived(ws.synced && ws.parts.length === 0);
	const neverGenerated = $derived(ws.synced && ws.parts.length > 0 && !Object.values(ws.results).some((r) => !r.empty));

	const ctxItems = $derived.by<MenuEntry[]>(() => {
		const t = ctxTarget;
		const sel = ws.selection;
		const items: MenuEntry[] = [];
		const target = t ?? sel[0];
		items.push({ label: 'Note', icon: MessageCircle, shortcut: ['C'], disabled: !target, onSelect: () => (ws.tool = 'note') });
		items.push({ label: 'Measure', icon: Ruler, shortcut: ['M'], onSelect: () => (ws.tool = 'measure') });
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
				disabled: !ws.kernelReady,
				onSelect: async () => {
					const edges = ws.results[target.part]?.faceEdges[target.index] ?? [];
					if (!edges.length) return;
					ws.select((await ws.engine!.loopOf(target.part, edges[0], target.index)).map((index) => ({ part: target.part, kind: 'edge' as const, index })));
				}
			});
		}
		items.push({ type: 'separator' });
		if (target) {
			items.push({ label: 'Isolate', icon: Focus, onSelect: () => ws.isolate(target.part) });
			items.push({ label: 'Hide part', icon: EyeOff, onSelect: () => ws.setHidden(target.part, true) });
		}
		items.push({ label: 'Zoom to', icon: Crosshair, shortcut: ['F'], onSelect: () => (sel.length ? viewer?.fitSelection() : viewer?.fit()) });
		if (target && target.kind !== ('part' as any)) {
			items.push({ type: 'separator' });
			items.push({
				label: 'Reveal source',
				icon: Code2,
				disabled: !ws.kernelReady,
				onSelect: async () => {
					const d = await ws.engine!.describe(target.part, target.kind, target.index);
					revealSource(d.createdBy?.source?.file, d.createdBy?.source?.line);
				}
			});
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
		onpointerleave={onLeave}
		onpointerdowncapture={onDown}
		onpointerup={onUp}
		data-testid="viewport"
		role="application"
		aria-label="3D viewport"
	></div>

	<ProgressLine active={busy} label={!ws.kernelReady ? 'Loading' : 'Regenerating'} class="absolute inset-x-0 top-0 z-10" />

	<div class="pointer-events-none absolute top-3 left-3 z-10 flex max-w-[calc(100%-140px)] flex-col items-start gap-1.5 [&>*]:pointer-events-auto">
		{#if ws.dirty.length}
			<div data-testid="unsaved-preview" in:rise={{ y: -4, scale: 0.97, origin: 'top left' }} out:fadeOut>
				<StatusPill tone="preview" title="Unsaved preview" detail="⌘S to save" />
			</div>
		{/if}
		{#if pill}
			<div class="max-w-[520px]" in:rise={{ y: -4, scale: 0.97, origin: 'top left' }} out:fadeOut>
				<StatusPill tone={pill.tone} title={pill.title} detail={pill.detail} message={pill.message} source={pill.source} bind:expanded={pillOpen} onSourceClick={() => revealSource(pill!.file, pill!.line)} />
			</div>
		{/if}
	</div>

	{#if ws.mode === 'model'}
		<div class="absolute top-[108px] right-[22px] z-10">
			<ViewportControls bind:display={ws.display} bind:ortho={ws.ortho} bind:filters={ws.filters} bind:section={() => !!ws.section, (v) => (ws.section = v ? { axis: 'Z', offset: 0, flip: false } : null)} orientation="vertical" onZoomToFit={() => viewer?.fit()} />
		</div>
	{/if}

	{#if box}
		<div
			class="pointer-events-none absolute z-20 border {box.x1 >= box.x0 ? 'border-accent bg-accent/8' : 'border-dashed border-accent bg-accent/5'}"
			style="left:{Math.min(box.x0, box.x1)}px;top:{Math.min(box.y0, box.y1)}px;width:{Math.abs(box.x1 - box.x0)}px;height:{Math.abs(box.y1 - box.y0)}px"
			data-testid="box-select"
		></div>
	{/if}
	{#if dim && dimPos}
		<div class="absolute z-20 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-panel border border-line-subtle bg-elevated py-1 pr-1 pl-2.5 shadow-popover" style="left:{dimPos.x}px;top:{dimPos.y}px" data-testid="measure-card">
			<span class="text-ui font-medium tabular-nums">{num(dim.distance, 2)} mm</span>
			{#if dim.angle !== undefined}<span class="text-label text-fg-secondary tabular-nums">· {num(dim.angle, 1)}°</span>{/if}
			<Button size="sm" variant="ghost" onclick={noteMeasurement}><MessageCircle size={14} /> Note</Button>
		</div>
	{/if}
	{#if ws.section}
		<div class="absolute top-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-panel border border-line-subtle bg-elevated py-1 pr-1 pl-3 shadow-toolbar" data-testid="section-bar">
			<span class="text-ui font-medium">Section</span>
			<SegmentedControl value={ws.section.axis} items={[{ value: 'X', text: 'X' }, { value: 'Y', text: 'Y' }, { value: 'Z', text: 'Z' }]} onValueChange={(v) => (ws.section = { axis: v as any, offset: 0, flip: false })} class="w-28" />
			<Slider value={ws.section.offset} min={sectionRange.min} max={sectionRange.max} step={(sectionRange.max - sectionRange.min) / 200 || 0.1} onValueChange={(v: number) => (ws.section = { ...ws.section!, offset: v })} class="w-40" aria-label="Section offset" />
			<span class="w-16 text-label text-fg-secondary tabular-nums">{num(ws.section.offset, 1)} mm</span>
			<IconButton label="Flip" size="sm" onclick={() => (ws.section = { ...ws.section!, flip: !ws.section!.flip })}><FlipVertical2 /></IconButton>
			<IconButton label="Close section" shortcut={['S']} size="sm" onclick={() => (ws.section = null)}><X /></IconButton>
		</div>
	{/if}

	{#if label && labelPos && !dim}
		<SelectionLabel value={label.value} unit={label.unit} class="pointer-events-none absolute z-10 -translate-x-1/2" style="left:{labelPos.x}px;top:{labelPos.y + 14}px" />
	{/if}

	{#if empty}
		<div class="absolute inset-0 z-10 grid place-items-center" data-testid="empty-document">
			<EmptyState size="panel" class="animate-enter" title="No parts yet">
				{#snippet action()}
					<div class="flex gap-2">
						<Button variant="primary" onclick={onAddPart} data-testid="add-part"><Plus size={14} /> Add a part</Button>
						<Button onclick={onConnect}><Bot size={14} /> Connect an agent</Button>
					</div>
				{/snippet}
			</EmptyState>
		</div>
	{:else if neverGenerated && !Object.values(ws.regen).some((s) => s === 'running')}
		<div class="pointer-events-none absolute inset-0 z-0 grid place-items-center text-fg-tertiary">
			<div class="flex flex-col items-center gap-2 text-ui"><Box size={28} strokeWidth={1.25} /> Generating…</div>
		</div>
	{/if}

	{#if viewer}
		<Pins {viewer} {nc} onopen={onOpenNote} />
	{/if}
	{#if nc.draft}
		<div class="absolute z-20" in:rise={{ y: 4, scale: 0.96, origin: 'top left' }} out:fadeOut style="left:{Math.min(nc.draft.screen.x + 12, (host?.clientWidth ?? 800) - 292)}px;top:{Math.max(8, Math.min(nc.draft.screen.y - 20, (host?.clientHeight ?? 600) - 140))}px">
			<NoteComposer {ws} {nc} />
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
