// Build steps in motion: from a build script's steps (engine) and where the assembly's copies are
// shown, how each copy travels in. A timeline position `pos` runs 0..steps: at an integer k the first
// k steps are done; between k and k + 1 step k's copies are on their way in. Every copy gets a world
// transform applied over its assembly pose (identity once in place) and is hidden before its step.
// A subassembly built on its own (a stage) plays alone, in its own coordinates (`frame`): while one
// of its steps is current only its copies show; the step that mounts it brings it in whole.
import * as THREE from 'three';
import type { BuildInfo, BuildStep } from '@parasocial/runtime/protocol';

/** Seconds a copy takes to go in, unless the step says. */
export const STEP_DURATION = 1.2;

/** How one copy (or a subassembly, all its copies alike) goes in. Everything in world coordinates. */
export type CopyMotion = {
	ids: string[];
	/** Seconds from the step's start. */
	delay: number;
	dur: number;
	/** Offsets from its place it passes through, the last one zero. */
	path: THREE.Vector3[];
	/** Insertion axis (unit) and the point it turns about. */
	axis: THREE.Vector3;
	pivot: THREE.Vector3;
	/** Radians about `axis` it still has to turn at the start. */
	turn: number;
	/** Where it grows from as it appears. */
	center: THREE.Vector3;
	/** Grows in as it appears (not a finished subassembly being mounted). */
	grow: boolean;
};

export type PlannedStep = {
	title: string;
	description?: string;
	parts: string[];
	auto?: boolean;
	source?: BuildStep['source'];
	/** The stage this step builds (its copies shown alone, in `frame`), or the one it mounts. */
	stage?: string;
	mount?: string;
	/** World → the stage's own coordinates (null: the assembly's). */
	frame: THREE.Matrix4 | null;
	length: number;
	moves: CopyMotion[];
};

export type StepScene = {
	/** A copy's pose (part → world). */
	pose(id: string): THREE.Matrix4;
	/** Its part's bounds in part coordinates (null: not regenerated). */
	bbox(id: string): THREE.Box3 | null;
	/** A connector frame of a part, in part coordinates. */
	connector(part: string, name: string, index?: number): { origin: THREE.Vector3; z: THREE.Vector3 } | null;
	/** World → a stage's own coordinates (where its subassembly sits on its own). */
	frame(stage: string): THREE.Matrix4;
};

/** Copies' bounds, each posed and then moved by `frame` (a stage's). */
const worldBox = (scene: StepScene, ids: string[], frame: THREE.Matrix4 | null = null) => {
	const box = new THREE.Box3();
	for (const id of ids) {
		const b = scene.bbox(id);
		if (b && !b.isEmpty()) box.union(b.clone().applyMatrix4(frame ? frame.clone().multiply(scene.pose(id)) : scene.pose(id)));
	}
	return box;
};

/** The step that's current at `pos`: the one playing, else the last one done (0 before any). */
export const currentStep = (n: number, pos: number) => (n ? Math.min(n - 1, Math.max(0, Math.ceil(pos - 1e-6) - 1)) : -1);

/** What's shown at `pos`: a stage's id while one of its steps is current, else undefined (the assembly). */
export const levelAt = (steps: PlannedStep[], pos: number) => steps[currentStep(steps.length, pos)]?.stage;

/** The bounds of a level once built: a stage's in its own coordinates, or the whole assembly. */
export function levelBox(steps: PlannedStep[], level: string | undefined, scene: StepScene) {
	const at = steps.filter((s) => s.stage === level);
	return worldBox(scene, at.flatMap((s) => s.parts), at[0]?.frame ?? null);
}

/** How far a box reaches along a unit axis. */
const extent = (b: THREE.Box3, axis: THREE.Vector3) => {
	const s = b.getSize(new THREE.Vector3());
	return Math.abs(s.x * axis.x) + Math.abs(s.y * axis.y) + Math.abs(s.z * axis.z);
};

/** Lay out every step's motion. */
export function planSteps(build: BuildInfo, scene: StepScene, sourcePart: (id: string) => string): PlannedStep[] {
	// a stage's steps move its copies in its own coordinates: lay them out from there
	const frames = new Map<string, THREE.Matrix4>();
	const frameOf = (stage: string | undefined) => (stage === undefined ? null : (frames.get(stage) ?? frames.set(stage, scene.frame(stage)).get(stage)!));
	const radius = new Map<string | undefined, number>();
	for (const s of build.steps) radius.set(s.stage, 0);
	for (const level of radius.keys()) {
		const box = worldBox(scene, build.steps.filter((s) => s.stage === level).flatMap((s) => s.parts), frameOf(level));
		radius.set(level, box.isEmpty() ? 50 : Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1));
	}
	return build.steps.map((s) => {
		const frame = frameOf(s.stage);
		const R = radius.get(s.stage)!;
		const posed = (id: string) => (frame ? frame.clone().multiply(scene.pose(id)) : scene.pose(id));
		// a subassembly moves as one; otherwise each copy on its own, `stagger` apart
		const units = s.units ?? s.parts.map((id) => [id]);
		const dur = s.duration ?? STEP_DURATION;
		const stagger = s.stagger ?? 0;
		const moves = units.map((ids, i): CopyMotion => {
			const box = worldBox(scene, ids, frame);
			const center = box.isEmpty() ? new THREE.Vector3().setFromMatrixPosition(posed(ids[0])) : box.getCenter(new THREE.Vector3());
			let axis = new THREE.Vector3(0, 0, 1);
			let pivot = center.clone();
			let path: THREE.Vector3[];
			const auto = (a: THREE.Vector3) => extent(box, a) * 1.2 + R * 0.15;
			if (s.from?.length) {
				path = [...s.from.map((v) => new THREE.Vector3(...v)), new THREE.Vector3()];
				const last = path[path.length - 2];
				if (last.lengthSq() > 1e-12) axis = last.clone().normalize();
			} else if (s.along) {
				if ('axis' in s.along) axis = new THREE.Vector3(...s.along.axis).normalize();
				else {
					const a = s.along;
					// on the copy named, else on this copy when it's of the connector's part
					const owner = a.owner ?? ids.find((id) => sourcePart(id) === a.part);
					const f = owner ? scene.connector(a.part, a.connector, a.index) : null;
					if (owner && f) {
						const m = posed(owner);
						pivot = f.origin.clone().applyMatrix4(m);
						axis = f.z.clone().transformDirection(m);
					}
				}
				path = [axis.clone().multiplyScalar(s.distance ?? auto(axis)), new THREE.Vector3()];
			} else path = [axis.clone().multiplyScalar(auto(axis)), new THREE.Vector3()];
			return { ids, delay: i * stagger, dur, path, axis, pivot, turn: THREE.MathUtils.degToRad(s.turn ?? 0), center, grow: !s.mount };
		});
		const length = Math.max(0.2, ...moves.map((m) => m.delay + m.dur));
		return { title: s.title, description: s.description, parts: s.parts, auto: s.auto, source: s.source, stage: s.stage, mount: s.mount, frame, length, moves };
	});
}

const easeInOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
const easeOut = (u: number) => 1 - (1 - u) ** 3;

/** Point at arc length share `e` (0 start, 1 end) along a polyline. */
function along(path: THREE.Vector3[], e: number, out: THREE.Vector3) {
	if (path.length === 1) return out.copy(path[0]);
	let total = 0;
	const lens = path.slice(1).map((p, i) => {
		const l = p.distanceTo(path[i]);
		total += l;
		return l;
	});
	if (total < 1e-9) return out.copy(path[path.length - 1]);
	let d = e * total;
	for (let i = 0; i < lens.length; i++) {
		if (d <= lens[i] || i === lens.length - 1) return out.lerpVectors(path[i], path[i + 1], lens[i] > 0 ? Math.min(1, d / lens[i]) : 1);
		d -= lens[i];
	}
	return out.copy(path[path.length - 1]);
}

const tmp = { v: new THREE.Vector3(), q: new THREE.Quaternion(), m: new THREE.Matrix4(), s: new THREE.Matrix4() };

/**
 * A copy's transform at progress `u` (0: about to appear, 1: in place), applied over its pose in
 * world coordinates; null when hidden (not started). It grows in as it appears, eases along its path
 * and turns the rest of its `turn` about its axis.
 */
export function motionAt(m: CopyMotion, u: number, out = new THREE.Matrix4()): THREE.Matrix4 | null {
	if (u <= 0) return null;
	if (u >= 1) return out.identity();
	const e = easeInOut(u);
	const g = m.grow ? Math.max(1e-3, easeOut(Math.min(1, u / 0.22))) : 1;
	// grow about its centre, turn about its axis, then move along the path
	out.makeTranslation(-m.center.x, -m.center.y, -m.center.z);
	out.premultiply(tmp.s.makeScale(g, g, g));
	out.premultiply(tmp.m.makeTranslation(m.center.x - m.pivot.x, m.center.y - m.pivot.y, m.center.z - m.pivot.z));
	out.premultiply(tmp.m.makeRotationFromQuaternion(tmp.q.setFromAxisAngle(m.axis, m.turn * (1 - e))));
	const off = along(m.path, e, tmp.v);
	out.premultiply(tmp.m.makeTranslation(m.pivot.x + off.x, m.pivot.y + off.y, m.pivot.z + off.z));
	return out;
}

/**
 * Where each copy is at timeline position `pos` (0..steps): its transform, or null while hidden.
 * Only the current step's level shows: a stage's copies alone while it's being built, else the
 * assembly's steps (a stage's copies come in with the step that mounts it).
 */
export function poseAt(steps: PlannedStep[], pos: number, each: (id: string, m: THREE.Matrix4 | null) => void) {
	const level = levelAt(steps, pos);
	const m = new THREE.Matrix4();
	const seen = new Set<string>();
	steps.forEach((s, k) => {
		if (s.stage !== level) return;
		const t = (pos - k) * s.length;
		for (const mv of s.moves) {
			const u = pos >= k + 1 ? 1 : pos <= k ? 0 : (t - mv.delay) / mv.dur;
			const at = motionAt(mv, u, m);
			if (at && s.frame) at.multiply(s.frame);
			for (const id of mv.ids) seen.add(id), each(id, at);
		}
	});
	for (const s of steps) for (const id of s.parts) if (!seen.has(id)) seen.add(id), each(id, null);
}
