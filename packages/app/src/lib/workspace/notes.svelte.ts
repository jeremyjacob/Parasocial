// Notes (§6): drafting from a pick, a selection or pencil strokes; snapshot upload then
// note.create; anchor resolution on every regeneration (name/query → nearest → orphaned);
// pin positions that follow their geometry.
import { mutators, type Note, type NoteTarget, type MarkupStroke } from '@parasocial/sync';
import type { EntityRef } from '@parasocial/viewer';
import type { Vec3 } from '@parasocial/kernel';
import { Vector3 } from 'three';
import { newID } from '$lib/zero';
import { toast } from '$lib/components/ui/toast';
import type { WorkspaceState } from './state.svelte';

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

	constructor(private ws: WorkspaceState) {}

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
	startFromStudio(file: string) {
		const ws = this.ws;
		if (ws.dirty.length) return toast('Save to add notes');
		if (!ws.viewer || !ws.partTree.some((g) => g.file === file)) return;
		ws.setActiveStudio(file);
		const bounds = ws.viewer.bounds();
		const center = bounds.isEmpty() ? new Vector3(...ws.viewer.cameraState().target) : bounds.getCenter(new Vector3());
		this.startFromTargets([{ ref: { kind: 'studio', studio: file }, point: center.toArray() as Vec3 }], ws.viewer.project(center) ?? { x: 200, y: 200 });
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

	async post(text: string) {
		const d = this.draft;
		const ws = this.ws;
		if (!d || !ws.viewer || this.posting) return false;
		this.posting = true;
		try {
			// names for the targets (stable names are how notes find their geometry again)
			const targets = await Promise.all(
				d.targets.map(async (t): Promise<NoteTarget> => {
					const r = t.ref;
					if (r.kind === 'studio') return { kind: 'studio', studio: r.studio, name: this.ws.partTree.find((g) => g.file === r.studio)?.name ?? r.studio, point: t.point };
					const name = await this.targetName(r);
					return { kind: r.kind, part: r.part, name, point: t.point, normal: 'normal' in t ? t.normal : undefined };
				})
			);
			// snapshot of the view (with markup) → upload first, then reference (§3)
			const blob = await ws.viewer.snapshot('image/webp', 0.85);
			const up = await fetch(`/api/blobs?document=${encodeURIComponent(ws.documentID)}`, { method: 'POST', body: blob, headers: { 'Content-Type': 'image/webp' } });
			if (!up.ok) throw new Error("Couldn't save the note. Try again.");
			const { hash } = await up.json();
			const cam = ws.viewer.cameraState();
			const id = newID();
			const anchor = {
				targets,
				camera: { position: cam.position as Vec3, target: cam.target as Vec3, up: cam.up as Vec3, fov: cam.fov, ortho: cam.ortho },
				version: ws.versions[0]?.id ?? '',
				configuration: ws.activeConfig?.name ?? 'Default',
				sectionPlane: ws.viewer.getSection() ?? undefined,
				snapshot: hash
			};
			await ws.mutate(mutators.note.create({ id, documentID: ws.documentID, anchor, text, strokeIDs: this.draftStrokeIDs } as any), 'Add note').then((r) => r.client);
			this.draft = null;
			this.active = id;
			if (ws.tool === 'note') ws.tool = 'select';
			return true;
		} catch (e) {
			toast.error((e as Error).message);
			return false;
		} finally {
			this.posting = false;
		}
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

	/** Re-anchor an orphaned note to a newly picked entity. */
	async reanchor(noteID: string, t: DraftTarget) {
		const ws = this.ws;
		const n = ws.notes.find((x) => x.id === noteID);
		if (!n) return;
		const r = t.ref;
		const name = await this.targetName(r);
		const anchor = { ...n.anchor, targets: [{ kind: r.kind, part: r.part, name, point: t.point, normal: t.normal }] };
		const { snapshot: _s, ...rest } = anchor as any;
		await ws.mutate(mutators.note.reanchor({ noteID, anchor: rest } as any), 'Re-anchor note');
		this.reanchoring = null;
		ws.tool = 'select';
	}

	// ---------- thread actions ----------
	reply(noteID: string, text: string) {
		return this.ws.mutate(mutators.note.reply({ id: newID(), noteID, text } as any), 'Reply');
	}
	setStatus(noteID: string, status: Note['status']) {
		return this.ws.mutate(mutators.note.setStatus({ noteID, status } as any), status === 'Resolved' ? 'Resolve note' : 'Reopen note');
	}
	remove(noteID: string) {
		return this.ws.mutate(mutators.note.remove({ noteID }), 'Remove note');
	}
	restore(noteID: string) {
		return this.ws.mutate(mutators.note.restore({ noteID }), 'Restore note');
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
			if (status !== 'unknown' && orphaned !== n.orphaned && (studio || partOk)) ws.zero.mutate(mutators.note.setOrphaned({ noteID: n.id, orphaned }));
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
