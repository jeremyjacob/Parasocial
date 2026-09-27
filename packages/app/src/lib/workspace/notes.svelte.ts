// Notes (§6): drafting from a pick, a selection or pencil strokes; snapshot upload then
// note.create; anchor resolution on every regeneration (name/query → nearest → orphaned);
// pin positions that follow their geometry.
import { mutators, type Note, type MarkupStroke } from '@parasocial/sync';
import type { EntityRef } from '@parasocial/viewer';
import type { Vec3 } from '@parasocial/kernel';
import { newID } from '$lib/zero';
import { toast } from '$lib/components/ui/toast';
import type { WorkspaceState } from './state.svelte';

export type DraftTarget = { ref: EntityRef; point: Vec3; normal?: Vec3 };
export type Draft = { targets: DraftTarget[]; strokeIDs: string[]; screen: { x: number; y: number }; text?: string };
export type Pin = { noteID: string; number: number; status: Note['status']; orphaned: boolean; removed: boolean; point: Vec3; part: string; resolution: string; authorKind: 'human' | 'agent'; authorName: string };

export const STROKE_COLORS = ['#e5484d', '#3e63dd', '#30a46c', '#18181b'] as const;

export class NotesController {
	draft = $state.raw<Draft | null>(null);
	/** False while the pencil is still drawing: the composer waits for a pause before appearing. */
	composerShown = $state(true);
	private composerTimer: ReturnType<typeof setTimeout> | undefined;
	pins = $state.raw<Pin[]>([]);
	hovered = $state<string | null>(null);
	active = $state<string | null>(null);
	filter = $state<{ status: 'all' | 'open' | 'review' | 'resolved' | 'removed'; part: string; author: string }>({ status: 'all', part: 'all', author: 'all' });
	strokes = $state.raw<MarkupStroke[]>([]);
	penColor = $state<string>(STROKE_COLORS[0]);
	eraser = $state(false);
	posting = $state(false);
	/** Note waiting to be re-anchored by the next pick. */
	reanchoring = $state<string | null>(null);
	private resolving = 0;

	constructor(private ws: WorkspaceState) {}

	/** Stable numbering: #1, #2… by creation order. */
	numberOf(noteID: string): number {
		const all = [...this.ws.notes].sort((a, b) => a.createdAt - b.createdAt);
		return all.findIndex((n) => n.id === noteID) + 1;
	}

	// ---------- drafting ----------
	startFromTargets(targets: DraftTarget[], screen: { x: number; y: number }, text?: string) {
		if (!targets.length) return;
		this.draft = { targets, strokeIDs: this.draft?.strokeIDs ?? [], screen, text };
		clearTimeout(this.composerTimer);
		this.composerShown = true;
		this.ws.rightTab = 'notes';
	}

	addStrokeToDraft(strokeID: string, crossed: DraftTarget[], screen: { x: number; y: number }) {
		const cur = this.draft;
		const seen = new Set((cur?.targets ?? []).map((t) => `${t.ref.part}:${t.ref.kind}:${t.ref.index}`));
		const targets = [...(cur?.targets ?? [])];
		for (const t of crossed) {
			const k = `${t.ref.part}:${t.ref.kind}:${t.ref.index}`;
			if (!seen.has(k)) (seen.add(k), targets.push(t));
		}
		this.draft = { targets, strokeIDs: [...(cur?.strokeIDs ?? []), strokeID], screen };
		if (!cur) this.composerShown = false;
		clearTimeout(this.composerTimer);
		if (!this.composerShown) this.composerTimer = setTimeout(() => (this.composerShown = true), 900);
	}

	/** A new pencil stroke started: keep the composer out of the way until the drawing pauses. */
	holdComposer() {
		clearTimeout(this.composerTimer);
	}

	async discard() {
		const d = this.draft;
		this.draft = null;
		clearTimeout(this.composerTimer);
		this.composerShown = true;
		// Esc discards the draft: drop its strokes too
		for (const id of d?.strokeIDs ?? []) this.ws.zero.mutate(mutators.markup.remove({ id }));
	}

	async post(text: string) {
		const d = this.draft;
		const ws = this.ws;
		if (!d || !ws.viewer || !ws.engine) return;
		this.posting = true;
		try {
			// names for the targets (stable names are how notes find their geometry again)
			const targets = await Promise.all(
				d.targets.map(async (t) => {
					const r = t.ref;
					if ((r.kind as string) === 'part') return { kind: 'part' as const, part: r.part, name: r.part, point: t.point, normal: t.normal };
					const desc = await ws.engine!.describe(r.part, r.kind, r.index);
					return { kind: r.kind, part: r.part, name: desc.name, point: t.point, normal: t.normal };
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
			await ws.mutate(mutators.note.create({ id, documentID: ws.documentID, anchor, text, strokeIDs: d.strokeIDs } as any), 'Add note').then((r) => r.client);
			this.draft = null;
			this.active = id;
			ws.tool = 'select';
		} catch (e) {
			toast.error((e as Error).message);
		} finally {
			this.posting = false;
		}
	}

	/** Re-anchor an orphaned note to a newly picked entity. */
	async reanchor(noteID: string, t: DraftTarget) {
		const ws = this.ws;
		const n = ws.notes.find((x) => x.id === noteID);
		if (!n || !ws.engine) return;
		const r = t.ref;
		const name = (r.kind as string) === 'part' ? r.part : (await ws.engine.describe(r.part, r.kind, r.index)).name;
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
		if (!ws.engine || !ws.kernelReady) return;
		const run = ++this.resolving;
		const pins: Pin[] = [];
		for (const n of ws.notes) {
			const t = n.anchor.targets[0];
			const part = t?.part ?? ws.parts[0];
			if (!t || !part) continue;
			let point = t.point as Vec3;
			let status = 'orphaned';
			const partOk = !!ws.results[part] && !ws.results[part].empty;
			if (partOk && (t.kind === 'part' || t.kind === 'point')) status = 'name';
			else if (partOk) {
				try {
					const [res] = await ws.engine.resolve(part, [{ kind: t.kind, name: t.name, query: t.query, point: t.point, normal: t.normal } as any]);
					status = res.status;
					if (res.indices.length) {
						const idx = res.indices.length > 1 ? await ws.engine.resolveOne(part, t.kind as any, res.indices, t.point) : res.indices[0];
						point = await ws.engine.closestPoint(part, t.kind as any, idx, t.point);
					}
				} catch {
					// an engine failure is not evidence the geometry is gone: keep the last known state
					status = n.orphaned ? 'orphaned' : 'unknown';
				}
			}
			if (run !== this.resolving) return; // a newer resolution started
			const orphaned = status === 'orphaned';
			if (status !== 'unknown' && orphaned !== n.orphaned && partOk) ws.zero.mutate(mutators.note.setOrphaned({ noteID: n.id, orphaned }));
			const agent = (n as any).authorAgent ?? (n.authorAgentID ? ws.agents.find((a) => a.id === n.authorAgentID) : null);
			pins.push({
				noteID: n.id,
				number: this.numberOf(n.id),
				status: n.status,
				orphaned,
				removed: !!n.removedAt,
				point,
				part,
				resolution: status,
				authorKind: agent ? 'agent' : 'human',
				authorName: agent ? agent.clientName : ((n as any).authorUser?.name ?? (n.authorUserID === ws.userID ? ws.userName : 'Someone'))
			});
		}
		this.pins = pins;
	}

	/** Refs of a note's targets on the current geometry (for hover highlight). */
	async targetRefs(n: Note): Promise<EntityRef[]> {
		const ws = this.ws;
		if (!ws.engine || !ws.kernelReady) return [];
		const out: EntityRef[] = [];
		for (const t of n.anchor.targets) {
			const part = t.part ?? ws.parts[0];
			if (!part || !ws.results[part]) continue;
			if (t.kind === 'part') {
				out.push({ part, kind: 'part' as any, index: 0 });
				continue;
			}
			if (t.kind === 'point') continue;
			try {
				const [r] = await ws.engine.resolve(part, [{ kind: t.kind, name: t.name, query: t.query, point: t.point } as any]);
				for (const index of r.indices) out.push({ part, kind: t.kind as any, index });
			} catch {}
		}
		return out;
	}
}
