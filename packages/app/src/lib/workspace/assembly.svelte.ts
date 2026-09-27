// Assemblies in the workspace: a solver per assembly (joints resolved against each part's
// connectors), the parts' poses in the viewer, dragging, saving where things were dragged to, and
// interference (red where parts overlap). Parts are modeled in place, so "no pose" means "where
// the script put it"; a pose is a transform from there.
import { Mechanism, toMatrix, isIdentity, type JointSpec, type Pose, type Vec3 } from '@parasocial/assembly';
import type { AssemblyInfo, PartPose } from '@parasocial/runtime/protocol';
import { mutators } from '@parasocial/sync';
import type { WorkspaceState } from './state.svelte';

type Built = { info: AssemblyInfo; mech: Mechanism; key: string; movable?: Map<string, boolean> };
export type Overlap = { a: string; b: string; volume: number };
export type AssemblyProblem = { assembly: string; message: string; source?: { file: string; line: number } };

const PREF = 'parasocial:interference';

export class AssemblyController {
	/** Assemblies the studios export (from the engine). */
	assemblies = $state.raw<AssemblyInfo[]>([]);
	/** Joints that couldn't be set up (a missing connector, a part in two assemblies), plus script errors. */
	problems = $state.raw<AssemblyProblem[]>([]);
	/** Where visible parts overlap right now. */
	overlaps = $state.raw<Overlap[]>([]);
	/** Red overlap volumes between assembly parts (on by default; remembered per browser). Other parts are never checked. */
	showInterference = $state(pref(PREF, true));
	/** The part being dragged, if any. */
	dragging = $state<string | null>(null);
	/** Current joint values per assembly (for display). */
	values = $state.raw<Record<string, Record<string, number[]>>>({});

	private built = new Map<string, Built>();
	/** Parts currently moved from their modeled pose. */
	private posed = new Set<string>();
	private drag: { built: Built; part: string; local: Vec3 } | null = null;
	private seq = 0;
	private shownSeq = 0;
	private checkTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private ws: WorkspaceState) {}

	/** Re-read the assembly list after scripts change. */
	async refresh() {
		const engine = this.ws.engine;
		if (!engine) return;
		try {
			this.assemblies = await engine.assemblies();
		} catch {
			return;
		}
		this.rebuild();
	}

	/** Parts that belong to some assembly. */
	get members(): Set<string> {
		const out = new Set<string>();
		for (const b of this.built.values()) for (const p of b.mech.bodies) out.add(p);
		return out;
	}

	/**
	 * (Re)build solvers whose joints changed: new assemblies, or connectors that moved because a
	 * part regenerated. Unchanged ones keep their current values.
	 */
	rebuild() {
		const results = this.ws.results;
		const problems: AssemblyProblem[] = [];
		const claimed = new Map<string, string>();
		const next = new Map<string, Built>();
		for (const info of this.assemblies) {
			for (const p of info.problems) problems.push({ assembly: info.id, message: p.message, source: p.source });
			const joints: JointSpec[] = [];
			let pending = false;
			for (const j of info.joints) {
				const owner = [j.a, j.b].find((p) => claimed.has(p) && claimed.get(p) !== info.id);
				if (owner) {
					problems.push({ assembly: info.id, message: `${this.nameOf(owner)} is already in the assembly "${this.asmName(claimed.get(owner)!)}"; a part can be in one assembly`, source: j.source });
					continue;
				}
				let frame = 'frame' in j.at ? j.at.frame : undefined;
				if ('connector' in j.at) {
					const r = results[j.at.part];
					if (!r || r.empty) {
						pending = true; // not regenerated yet: build once it has
						continue;
					}
					frame = r.connectors?.[j.at.connector];
					if (!frame) {
						problems.push({ assembly: info.id, message: `${this.nameOf(j.at.part)} has no connector "${j.at.connector}": add .connector("${j.at.connector}", ...) to its body`, source: j.source });
						continue;
					}
				}
				joints.push({ name: j.name, type: j.type, a: j.a, b: j.b, frame: frame!, limits: j.limits, value: j.value });
			}
			if (pending || !joints.length) continue;
			for (const j of joints) for (const p of [j.a, j.b]) claimed.set(p, info.id);
			const fixed = info.fixed;
			const key = JSON.stringify([joints, fixed]);
			const prev = this.built.get(info.id);
			if (prev && prev.key === key) {
				next.set(info.id, { ...prev, info });
				continue;
			}
			const mech = new Mechanism({ joints, fixed, scale: this.scale(joints) });
			// where it was left: saved values, else the current ones of the previous build, else the script's
			const saved = this.saved(info.id) ?? (prev ? prev.mech.values() : null);
			const err = saved ? mech.setValues(saved) : mech.settle();
			if (err > 1e-3) problems.push({ assembly: info.id, message: `the joints of "${info.name}" can't all be satisfied (off by ${err.toFixed(2)}): check that connectors line up where the parts are modeled` });
			next.set(info.id, { info, mech, key });
		}
		this.built = next;
		this.problems = problems;
		this.apply();
	}

	/** Someone (maybe another tab) saved new positions: follow, unless we're dragging. */
	onSaved() {
		if (this.drag) return;
		let changed = false;
		for (const [id, b] of this.built) {
			const saved = this.saved(id);
			if (!saved) continue;
			const cur = b.mech.values();
			if (Object.keys(saved).some((k) => JSON.stringify(saved[k]) !== JSON.stringify(cur[k]))) {
				b.mech.setValues(saved);
				changed = true;
			}
		}
		if (changed) this.apply();
	}

	/** Could this part be dragged? (Asked on every hover: cached per solver.) */
	movable(part: string): boolean {
		const b = this.builtWith(part);
		if (!b) return false;
		b.movable ??= new Map();
		let m = b.movable.get(part);
		if (m === undefined) b.movable.set(part, (m = b.mech.movable(part)));
		return m;
	}

	/** Start dragging `part` by the point `local` (part coordinates). False when it can't move. */
	startDrag(part: string, local: Vec3): boolean {
		const built = this.builtWith(part);
		if (!built || !this.movable(part)) return false;
		this.drag = { built, part, local };
		this.dragging = part;
		return true;
	}

	/** Move the grabbed point toward `target` (world). */
	dragTo(target: Vec3) {
		const d = this.drag;
		if (!d) return;
		if (d.built.mech.drag(d.part, d.local, target)) this.apply();
	}

	/** Finish a drag: save where it ended up (undoable). */
	async endDrag() {
		const d = this.drag;
		this.drag = null;
		this.dragging = null;
		if (!d) return;
		const values = d.built.mech.values();
		const saved = this.saved(d.built.info.id);
		this.check();
		if (saved && JSON.stringify(saved) === JSON.stringify(values)) return;
		await this.ws.mutate(mutators.document.setPose({ id: this.ws.documentID, assembly: d.built.info.id, joints: values }), `Move ${this.nameOf(d.part)}`);
	}

	/** Put every assembly back where it's modeled (clears saved positions). */
	async resetPoses() {
		for (const [id, b] of this.built) {
			b.mech.setValues(Object.fromEntries(b.info.joints.map((j) => [j.name, j.value])));
			if (this.saved(id)) await this.ws.mutate(mutators.document.setPose({ id: this.ws.documentID, assembly: id, joints: null }), 'Reset positions');
		}
		this.apply();
	}

	setShowInterference(on: boolean) {
		this.showInterference = on;
		try {
			localStorage.setItem(PREF, String(on));
		} catch {}
		this.check();
	}

	/** Current poses (parts moved from their modeled position). */
	poses(): Record<string, PartPose> {
		const out: Record<string, PartPose> = {};
		for (const b of this.built.values()) for (const [p, pose] of b.mech.poses()) if (!isIdentity(pose)) out[p] = pose;
		return out;
	}

	/** Push poses to the viewer (every frame of a drag) and refresh interference. */
	apply() {
		const v = this.ws.viewer;
		const poses = this.poses();
		if (v) {
			for (const p of this.posed) if (!(p in poses)) v.setPartTransform(p, null);
			for (const [p, pose] of Object.entries(poses)) v.setPartTransform(p, toMatrix(pose as Pose));
		}
		this.posed = new Set(Object.keys(poses));
		this.values = Object.fromEntries([...this.built].map(([id, b]) => [id, b.mech.values()]));
		this.check(!!this.drag);
	}

	/** Re-apply transforms to a new viewer (remount). */
	attach() {
		this.posed = new Set();
		this.apply();
	}

	/**
	 * Recompute where visible parts overlap. While dragging, every frame asks (the engine only
	 * works on the newest); otherwise a short debounce collects bursts of changes.
	 */
	check(now = false) {
		clearTimeout(this.checkTimer);
		if (now) return void this.runCheck();
		this.checkTimer = setTimeout(() => this.runCheck(), 60);
	}

	private async runCheck() {
		const ws = this.ws;
		const engine = ws.engine;
		if (!engine || !ws.kernelReady) return;
		// scrubbing and typing regenerate every frame: check once they settle
		if (ws.scrubbing || ws.typing) return void (this.checkTimer = setTimeout(() => this.runCheck(), 250));
		const poses = this.poses();
		const seq = ++this.seq;
		// only parts in an assembly: elsewhere, overlapping parts are just how things are modeled
		const members = this.members;
		const parts = ws.parts.filter((p) => members.has(p) && ws.results[p] && !ws.results[p].empty && !ws.hidden.includes(p) && (!ws.isolated.length || ws.isolated.includes(p)));
		if (!this.showInterference || parts.length < 2) {
			this.shownSeq = seq;
			if (this.overlaps.length) (this.overlaps = []), ws.viewer?.setInterferences([]);
			engine.setPoses(poses).catch(() => {});
			return;
		}
		const ignore: [string, string][] = [];
		for (const a of this.assemblies) for (const j of a.joints) if (j.overlap) ignore.push([j.a, j.b]);
		let list;
		try {
			list = await engine.interferences(parts, ignore, poses);
		} catch {
			return;
		}
		// superseded, or an older answer arriving after a newer one
		if (!list || seq < this.shownSeq) return;
		this.shownSeq = seq;
		ws.viewer?.setInterferences(list.flatMap((x) => (x.mesh ? [{ a: x.a, b: x.b, mesh: x.mesh }] : [])));
		this.overlaps = list.map(({ a, b, volume }) => ({ a, b, volume }));
	}

	private builtWith(part: string): Built | undefined {
		for (const b of this.built.values()) if (b.mech.bodies.includes(part)) return b;
	}

	private saved(id: string): Record<string, number[]> | null {
		const all = (this.ws.doc?.settings as any)?.poses;
		const v = all && typeof all === 'object' ? all[id] : null;
		return v && typeof v === 'object' ? v : null;
	}

	/** Characteristic length for the solver: the size of the parts involved. */
	private scale(joints: JointSpec[]) {
		let s = 0;
		for (const j of joints)
			for (const p of [j.a, j.b]) {
				const bb = this.ws.results[p]?.bbox;
				if (bb) s = Math.max(s, Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) / 2);
			}
		return s || 50;
	}

	private nameOf(part: string) {
		return this.ws.results[part]?.name ?? this.ws.partInfos.find((p) => p.id === part)?.name ?? part;
	}
	private asmName(id: string) {
		return this.assemblies.find((a) => a.id === id)?.name ?? id;
	}
}

function pref(key: string, fallback: boolean): boolean {
	try {
		const v = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
		return v === null ? fallback : v === 'true';
	} catch {
		return fallback;
	}
}
