// Assemblies in the workspace: a solver per assembly (joints resolved against each part's
// connectors), the poses of its instances in the viewer, dragging, saving where things were dragged
// to, and interference (red where instances overlap). An assembly holds its own copies of the parts
// (instances, `<assembly>/<part>`, `<assembly>/<part>@<name>` for more copies): moving them never
// moves the parts in their studios. A pose is an instance's transform from where its part is
// modeled: copies placed elsewhere (or put against another by connector-to-connector joints) have
// one even at home.
import { Mechanism, toMatrix, isIdentity, type JointSpec, type Pose, type Vec3 } from '@parasocial/assembly';
import { sourcePart, type AssemblyInfo, type PartPose } from '@parasocial/runtime/protocol';
import { resolveAssembly } from '@parasocial/runtime/mechanism';
import { mutators } from '@parasocial/sync';
import type { WorkspaceState } from './state.svelte';

type Built = { info: AssemblyInfo; mech: Mechanism; key: string; movable?: Map<string, boolean>; driverList?: string[] };
export type Overlap = { a: string; b: string; volume: number };
export type AssemblyProblem = { assembly: string; message: string; source?: { file: string; line: number } };

const PREF = 'parasocial:interference';
const PREF_ON_TOP = 'parasocial:interference-on-top';

export class AssemblyController {
	/** Assemblies the studios export (from the engine). */
	assemblies = $state.raw<AssemblyInfo[]>([]);
	/** Joints that couldn't be set up (a missing connector), plus script errors. */
	problems = $state.raw<AssemblyProblem[]>([]);
	/** Where the shown assembly's instances overlap right now. */
	overlaps = $state.raw<Overlap[]>([]);
	/** Red overlap volumes between assembly instances (on by default; remembered per browser). Parts in their studios are never checked. */
	showInterference = $state(pref(PREF, true));
	/** Overlap volumes drawn through the geometry covering them (x-ray), or only where visible. Remembered per browser. */
	interferenceOnTop = $state(pref(PREF_ON_TOP, true));
	/** The instance being dragged, if any. */
	dragging = $state<string | null>(null);
	/** Per assembly, the joints that drive it (the rest follow them around closed loops). */
	drivers = $state.raw<Record<string, string[]>>({});
	/** Current joint values per assembly (for display). */
	values = $state.raw<Record<string, Record<string, number[]>>>({});

	private built = new Map<string, Built>();
	/** Instances currently moved from their modeled pose. */
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
		this.ws.syncInstances();
		this.rebuild();
	}

	/** Instances in some assembly. */
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
		const next = new Map<string, Built>();
		for (const info of this.assemblies) {
			for (const p of info.problems) problems.push({ assembly: info.id, message: p.message, source: p.source });
			// connectors from each part's regeneration (null: not regenerated yet, build once it has)
			const resolved = resolveAssembly(
				info,
				(part) => {
					const r = results[part];
					return !r || r.empty ? null : (r.connectors ?? {});
				},
				(part) => this.nameOf(part)
			);
			for (const p of resolved.problems) problems.push({ assembly: info.id, ...p });
			const { joints, home } = resolved.spec;
			if (resolved.pending || (!joints.length && Object.values(home ?? {}).every((p) => isIdentity(p)))) continue;
			const fixed = info.fixed;
			const key = JSON.stringify([joints, fixed, home]);
			const prev = this.built.get(info.id);
			if (prev && prev.key === key) {
				next.set(info.id, { ...prev, info });
				continue;
			}
			const mech = new Mechanism({ ...resolved.spec, scale: this.scale(joints) });
			// where it was left: saved values, else the current ones of the previous build, else the script's
			const saved = this.saved(info.id) ?? (prev ? prev.mech.values() : null);
			const err = saved ? mech.setValues(saved) : mech.settle();
			if (err > 1e-3) problems.push({ assembly: info.id, message: `the joints of "${info.name}" can't all be satisfied (off by ${err.toFixed(2)}): check that connectors line up where the parts are modeled or placed` });
			next.set(info.id, { info, mech, key });
		}
		this.built = next;
		this.problems = problems;
		this.drivers = Object.fromEntries([...next].map(([id, b]) => [id, b.driverList ??= b.mech.drivers()]));
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

	/** Could this instance be dragged? (Asked on every hover: cached per solver.) Parts in their studios never move. */
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

	/** Set one joint's value (degrees, millimetres) while it's being edited; the rest settle around it. */
	setJoint(assembly: string, joint: string, value: number[]) {
		const b = this.built.get(assembly);
		if (!b) return;
		b.mech.setValues({ [joint]: value });
		this.apply();
	}

	/** Finish editing a joint: save where the assembly ended up (undoable). */
	async commitJoint(assembly: string, joint: string, value: number[], label = joint) {
		const b = this.built.get(assembly);
		if (!b) return;
		this.setJoint(assembly, joint, value);
		const values = b.mech.values();
		const saved = this.saved(assembly);
		if (saved && JSON.stringify(saved) === JSON.stringify(values)) return;
		await this.ws.mutate(mutators.document.setPose({ id: this.ws.documentID, assembly, joints: values }), `Set ${label}`);
	}

	/** Put every assembly back in its home pose (clears saved positions). */
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

	setInterferenceOnTop(on: boolean) {
		this.interferenceOnTop = on;
		try {
			localStorage.setItem(PREF_ON_TOP, String(on));
		} catch {}
	}

	/** Current poses (instances away from where their part is modeled). */
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
		// only the shown assembly's instances: in a studio, overlapping parts are just how things are modeled
		const members = this.members;
		const parts = ws.shownParts.filter((p) => members.has(p) && ws.results[p] && !ws.results[p].empty && !ws.hidden.includes(p));
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
				const bb = this.ws.results[sourcePart(p)]?.bbox;
				if (bb) s = Math.max(s, Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) / 2);
			}
		return s || 50;
	}

	private nameOf(part: string) {
		return this.ws.results[part]?.name ?? this.ws.partInfos.find((p) => p.id === sourcePart(part))?.name ?? part;
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
