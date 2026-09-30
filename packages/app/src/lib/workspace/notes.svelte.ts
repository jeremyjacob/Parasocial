// Notes (§6): drafting from a pick, a selection or pencil strokes; snapshot upload then
// note.create; anchor resolution on every regeneration (name/query → nearest → orphaned);
// pin positions that follow their geometry.
import { mutators, type Note, type NoteTarget, type MarkupStroke } from '@parasocial/sync';
import type { EntityRef } from '@parasocial/viewer';
import type { Vec3 } from '@parasocial/kernel';
import { Vector3 } from 'three';
import { SvelteMap } from 'svelte/reactivity';
import { newID } from '$lib/zero';
import { toast } from '$lib/components/ui/toast';
import type { WorkspaceState } from './state.svelte';
import { Attachments } from './attachments.svelte';

export type DraftTarget = { ref: Omit<EntityRef, 'kind'> & { kind: EntityRef['kind'] | 'part' }; point: Vec3; normal?: Vec3 };
export type StudioDraftTarget = { ref: { kind: 'studio'; studio: string; part?: never; index?: never }; point: Vec3 };
export type Draft = { targets: (DraftTarget | StudioDraftTarget)[]; strokeIDs: string[]; screen: { x: number; y: number }; text?: string };
export type Pin = { noteID: string; number: number; status: Note['status']; orphaned: boolean; removed: boolean; point: Vec3; part?: string; studio?: string; resolution: string; authorKind: 'human' | 'agent'; authorName: string };

export const STROKE_COLORS = ['#e5484d', '#3e63dd', '#30a46c', '#18181b'] as const;

export class NotesController {
	draft = $state.raw<Draft | null>(null);
	/** False while the pencil is still drawing: the composer waits for a pause before appearing. */
	composerShown = $state(true);
	private composerTimer: ReturnType<typeof setTimeout> | undefined;
	pins = $state.raw<Pin[]>([]);
	hovered = $state<string | null>(null);
	active = $state<string | null>(null);
	filter = $state<{ status: 'all' | 'open' | 'resolved' | 'removed'; part: string; author: string }>({ status: 'all', part: 'all', author: 'all' });
	strokes = $state.raw<MarkupStroke[]>([]);
	penColor = $state<string>(STROKE_COLORS[0]);
	eraser = $state(false);
	posting = $state(false);
	/** Note waiting to be re-anchored by the next pick. */
	reanchoring = $state<string | null>(null);
	private resolving = 0;
	/** Images in threads: blob hash → displayable URL (signed, or the local copy of your own upload). */
	private imageURLs = new SvelteMap<string, string>();
	private unsigned = new Set<string>();
	private signTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private ws: WorkspaceState) {}

	/** Pasted images for a new note or a reply. */
	attachments() {
		return new Attachments(
			() => this.ws.documentID,
			(hash, url) => this.imageURLs.set(hash, url)
		);
	}

	/** A URL for an image in a thread, or undefined until it's signed (batched: one request per burst). */
	imageURL(hash: string): string | undefined {
		const url = this.imageURLs.get(hash);
		if (url || this.unsigned.has(hash)) return url;
		this.unsigned.add(hash);
		this.signTimer ??= setTimeout(() => this.sign(), 0);
	}

	private async sign() {
		this.signTimer = undefined;
		const hashes = [...this.unsigned].filter((h) => !this.imageURLs.has(h));
		if (!hashes.length) return;
		try {
			const res = await fetch('/api/blobs/sign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documentID: this.ws.documentID, hashes }) });
			if (!res.ok) throw new Error(String(res.status));
			const { urls } = (await res.json()) as { urls: Record<string, string> };
			for (const [h, u] of Object.entries(urls)) this.imageURLs.set(h, u);
			// signed for an hour: sign again well before they expire
			setTimeout(() => {
				for (const h of Object.keys(urls)) if (this.imageURLs.get(h) === urls[h]) this.imageURLs.delete(h), this.unsigned.delete(h);
			}, 50 * 60_000);
		} catch {
			// not signed (not synced to the server yet, or offline): let the next render ask again
			setTimeout(() => hashes.forEach((h) => this.unsigned.delete(h)), 5_000);
		}
	}

	/** Keep draft IDs through undo/redo; only existing, unattached strokes can be posted or discarded. */
	get draftStrokeIDs(): string[] {
		const live = new Set(this.strokes.filter((s) => !s.noteID).map((s) => s.id));
		return (this.draft?.strokeIDs ?? []).filter((id) => live.has(id));
	}

	/** Stable numbering: #1, #2… by creation order. */
	numberOf(noteID: string): number {
		const all = [...this.ws.notes].sort((a, b) => a.createdAt - b.createdAt);
		return all.findIndex((n) => n.id === noteID) + 1;
	}

	// ---------- drafting ----------
	private studioTarget(file: string): StudioDraftTarget | null {
		const ws = this.ws;
		if (!ws.viewer || !ws.partTree.some((g) => g.file === file)) return null;
		ws.setActiveStudio(file);
		const bounds = ws.viewer.bounds();
		const center = bounds.isEmpty() ? new Vector3(...ws.viewer.cameraState().target) : bounds.getCenter(new Vector3());
		return { ref: { kind: 'studio', studio: file }, point: center.toArray() as Vec3 };
	}

	startFromStudio(file: string) {
		if (this.ws.dirty.length) return toast('Save to add notes');
		const target = this.studioTarget(file);
		if (target) this.startFromTargets([target], this.ws.viewer!.project(new Vector3(...target.point)) ?? { x: 200, y: 200 });
	}

	startFromTargets(targets: Draft['targets'], screen: { x: number; y: number }, text?: string) {
		if (!targets.length) return;
		this.draft = { targets, strokeIDs: this.draft?.strokeIDs ?? [], screen, text };
		// a new note, not the one already on this geometry
		this.active = null;
		clearTimeout(this.composerTimer);
		this.composerShown = true;
		this.ws.rightTab = 'notes';
	}

	addStrokeToDraft(strokeID: string, crossed: DraftTarget[], screen: { x: number; y: number }) {
		const cur = this.draft;
		const seen = new Set((cur?.targets ?? []).filter((t) => t.ref.kind !== 'studio').map((t) => `${t.ref.part}:${t.ref.kind}:${t.ref.index}`));
		const targets = [...(cur?.targets ?? [])];
		for (const t of crossed) {
			const k = `${t.ref.part}:${t.ref.kind}:${t.ref.index}`;
			if (!seen.has(k)) (seen.add(k), targets.push(t));
		}
		this.draft = { targets, strokeIDs: [...(cur?.strokeIDs ?? []), strokeID], screen };
		if (!cur) this.composerShown = false;
		clearTimeout(this.composerTimer);
		if (!this.composerShown) this.composerTimer = setTimeout(() => (this.composerShown = true), 650);
	}

	/** A new pencil stroke started: keep the composer out of the way until the drawing pauses. */
	holdComposer() {
		clearTimeout(this.composerTimer);
	}

	async discard() {
		const strokeIDs = this.draftStrokeIDs;
		this.draft = null;
		clearTimeout(this.composerTimer);
		this.composerShown = true;
		// Esc discards the draft: drop its strokes too
		for (const id of strokeIDs) this.ws.zero.mutate(mutators.markup.remove({ id }));
	}

	async post(text: string, images?: Attachments) {
		const d = this.draft;
		if (!d || !this.ws.viewer || this.posting) return false;
		this.posting = true;
		try {
			const hashes = (await images?.hashes()) ?? [];
			const id = await this.create(d.targets, text, this.draftStrokeIDs, false, hashes);
			this.draft = null;
			this.active = id;
			if (this.ws.tool === 'note' || this.ws.tool === 'pencil') this.ws.tool = 'select';
			return true;
		} catch (e) {
			toast.error((e as Error).message);
			return false;
		} finally {
			this.posting = false;
		}
	}

	/**
	 * A note on a whole studio, handed straight to the built-in agent (a new studio built from a
	 * prompt). Waits briefly for the studio's first geometry so the snapshot shows it.
	 */
	async postToAgent(file: string, text: string) {
		const ws = this.ws;
		ws.setActiveStudio(file);
		const ids = () => ws.partTree.find((g) => g.file === file)?.ids ?? [];
		for (let t = 0; t < 40 && !(ids().length && ids().every((p) => ws.results[p])); t++) await new Promise((r) => setTimeout(r, 100));
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
		const target = this.studioTarget(file);
		if (!target) throw new Error("Couldn't open the new studio. Try again.");
		const id = await this.create([target], text, [], true);
		this.active = id;
		ws.rightTab = 'notes';
		return id;
	}

	/** Names the targets, uploads the view snapshot (upload first, then reference: §3), creates the note. */
	private async create(targets: Draft['targets'], text: string, strokeIDs: string[], assignAgent = false, images: string[] = []) {
		const ws = this.ws;
		const viewer = ws.viewer!;
		// names for the targets (stable names are how notes find their geometry again)
		const named = await Promise.all(targets.map((t) => this.anchorTarget(t)));
		const blob = await viewer.snapshot('image/webp', 0.85);
		const up = await fetch(`/api/blobs?document=${encodeURIComponent(ws.documentID)}`, { method: 'POST', body: blob, headers: { 'Content-Type': 'image/webp' } });
		if (!up.ok) throw new Error("Couldn't save the note. Try again.");
		const { hash } = await up.json();
		const cam = viewer.cameraState();
		const id = newID();
		const anchor = {
			targets: named,
			camera: { position: cam.position as Vec3, target: cam.target as Vec3, up: cam.up as Vec3, fov: cam.fov, ortho: cam.ortho },
			version: ws.versions[0]?.id ?? '',
			configuration: ws.activeConfig?.name ?? 'Default',
			sectionPlane: viewer.getSection() ?? undefined,
			snapshot: hash
		};
		await ws.mutate(mutators.note.create({ id, documentID: ws.documentID, anchor, text, strokeIDs, assignAgent, images } as any), 'Add note').then((r) => r.client);
		return id;
	}

	private async anchorTarget(t: Draft['targets'][number]): Promise<NoteTarget> {
		const r = t.ref;
		if (r.kind === 'studio') return { kind: 'studio', studio: r.studio, name: this.ws.partTree.find((g) => g.file === r.studio)?.name ?? r.studio, point: t.point };
		const name = await this.targetName(r);
		return { kind: r.kind, part: r.part, name, point: t.point, normal: 'normal' in t ? t.normal : undefined };
	}

	/** Names belong to the displayed mesh, which may be available before the engine boots. */
	private async targetName(ref: DraftTarget['ref']): Promise<string> {
		if (ref.kind === 'part') return ref.part;
		const names = this.ws.results[ref.part]?.names;
		const cached = ref.kind === 'face' || ref.kind === 'edge' ? names?.[ref.kind]?.[ref.index] : undefined;
		if (cached) return cached;
		if (!this.ws.engine || !this.ws.kernelReady) throw new Error("The model is still loading. Your note is kept; try again once it's ready.");
		return (await this.ws.engine.describe(ref.part, ref.kind, ref.index)).name;
	}

	async reanchorStudio(noteID: string, file: string) {
		if (this.ws.dirty.length) return toast('Save to reattach notes');
		const target = this.studioTarget(file);
		if (target) await this.reanchor(noteID, target);
	}

	/** Re-anchor an orphaned note to a newly picked target. */
	async reanchor(noteID: string, t: Draft['targets'][number]) {
		const ws = this.ws;
		const n = ws.notes.find((x) => x.id === noteID);
		if (!n) return;
		const anchor = { ...n.anchor, targets: [await this.anchorTarget(t)] };
		const { snapshot: _s, ...rest } = anchor as any;
		await ws.mutate(mutators.note.reanchor({ noteID, anchor: rest } as any), 'Re-anchor note');
		this.reanchoring = null;
		ws.tool = 'select';
	}

	// ---------- thread actions ----------
	reply(noteID: string, text: string, images: string[] = []) {
		return this.ws.mutate(mutators.note.reply({ id: newID(), noteID, text, images } as any), 'Reply');
	}
	setStatus(noteID: string, status: Note['status']) {
		return this.ws.mutate(mutators.note.setStatus({ noteID, status } as any), status === 'Resolved' ? 'Mark note done' : 'Reopen note');
	}
	remove(noteID: string) {
		return this.ws.mutate(mutators.note.remove({ noteID }), 'Remove note');
	}
	restore(noteID: string) {
		return this.ws.mutate(mutators.note.restore({ noteID }), 'Restore note');
	}
	/** Hand a note to the built-in agent (runs on your provider), or take it back (stops a run). */
	assignAgent(noteID: string, assign: boolean) {
		return this.ws.mutate(mutators.note.assignAgent({ noteID, assign }), assign ? 'Hand to agent' : 'Take back from agent');
	}

	// ---------- resolution (every regeneration) ----------
	/** Resolve every note's targets against the current geometry and place pins. */
	async resolveAll() {
		const ws = this.ws;
		const run = ++this.resolving;
		const pins: Pin[] = [];
		for (const n of ws.notes) {
			const t = n.anchor.targets[0];
			if (!t) continue;
			const studio = t.kind === 'studio' ? t.studio : undefined;
			const part = t.kind === 'studio' ? undefined : t.part ?? ws.parts[0];
			if (!studio && !part) continue;
			let point = t.point as Vec3;
			const unresolved = n.orphaned ? 'orphaned' : 'unknown';
			let status = 'orphaned';
			if (!ws.engine || !ws.kernelReady) status = unresolved;
			const partOk = !!part && !!ws.results[part] && !ws.results[part].empty;
			if (t.kind === 'studio') status = ws.scripts.some((s) => s.path === t.studio) ? 'name' : 'orphaned';
			else if (partOk && (t.kind === 'part' || t.kind === 'point')) status = 'name';
			else if (part && partOk && ws.engine && ws.kernelReady) {
				try {
					const [res] = await ws.engine.resolve(part, [{ kind: t.kind, name: t.name, query: t.query, point: t.point, normal: t.normal } as any]);
					status = res.status;
					if (res.indices.length) {
						const idx = res.indices.length > 1 ? await ws.engine.resolveOne(part, t.kind as any, res.indices, t.point) : res.indices[0];
						point = await ws.engine.closestPoint(part, t.kind as any, idx, t.point);
					}
				} catch {
					// an engine failure is not evidence the geometry is gone: keep the last known state
					status = unresolved;
				}
			}
			if (run !== this.resolving) return; // a newer resolution started
			const orphaned = status === 'orphaned';
			// the stored flag is about the saved Default geometry: a tab looking at a configuration,
			// scrub or unsaved edit would fight other tabs over it (each write re-resolves them all)
			const canonical = ws.activeConfigID === null && !Object.keys(ws.live).length && !ws.dirty.length;
			if (canonical && status !== 'unknown' && orphaned !== n.orphaned && (studio || partOk)) ws.zero.mutate(mutators.note.setOrphaned({ noteID: n.id, orphaned }));
			const agent = (n as any).authorAgent ?? (n.authorAgentID ? ws.agents.find((a) => a.id === n.authorAgentID) : null);
			pins.push({
				noteID: n.id,
				number: this.numberOf(n.id),
				status: n.status,
				orphaned,
				removed: !!n.removedAt,
				point,
				part,
				studio,
				resolution: status,
				authorKind: agent ? 'agent' : 'human',
				authorName: agent ? agent.clientName : ((n as any).authorUser?.name ?? (n.authorUserID === ws.userID ? ws.userName : 'Someone'))
			});
		}
		// A local or synced resolution ends the previous interaction. Only clear on
		// the transition, so a resolved thread can still be deliberately revealed later.
		const previouslyOpen = new Set(this.pins.filter((p) => p.status !== 'Resolved').map((p) => p.noteID));
		for (const p of pins) {
			if (p.status !== 'Resolved' || !previouslyOpen.has(p.noteID)) continue;
			if (this.active === p.noteID) this.active = null;
			if (this.hovered === p.noteID) this.hovered = null;
		}
		this.pins = pins;
	}

	/** Refs of a note's targets on the current geometry (for hover highlight). */
	async targetRefs(n: Note): Promise<EntityRef[]> {
		const ws = this.ws;
		const out: EntityRef[] = [];
		for (const t of n.anchor.targets) {
			if (t.kind === 'studio') {
				for (const part of ws.partTree.find((g) => g.file === t.studio)?.ids ?? []) {
					if (ws.results[part] && !ws.results[part].empty) out.push({ part, kind: 'part' as any, index: 0 });
				}
				continue;
			}
			const part = t.part ?? ws.parts[0];
			if (!part || !ws.results[part]) continue;
			if (t.kind === 'part') {
				out.push({ part, kind: 'part' as any, index: 0 });
				continue;
			}
			if (t.kind === 'point' || !ws.engine || !ws.kernelReady) continue;
			try {
				const [r] = await ws.engine.resolve(part, [{ kind: t.kind, name: t.name, query: t.query, point: t.point } as any]);
				for (const index of r.indices) out.push({ part, kind: t.kind as any, index });
			} catch {}
		}
		return out;
	}
}
