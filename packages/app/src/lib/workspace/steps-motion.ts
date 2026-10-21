// Build steps in motion: from a build script's steps (engine) and where the assembly's copies are
// shown, how each copy travels in. A timeline position `pos` runs 0..steps: at an integer k the first
// k steps are done; between k and k + 1 step k's copies are on their way in. Every copy gets a world
// transform applied over its assembly pose (identity once in place) and is hidden before its step.
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
};

export type PlannedStep = { title: string; description?: string; parts: string[]; auto?: boolean; source?: BuildStep['source']; length: number; moves: CopyMotion[] };

export type StepScene = {
	/** A copy's pose (part → world). */
	pose(id: string): THREE.Matrix4;
	/** Its part's bounds in part coordinates (null: not regenerated). */
	bbox(id: string): THREE.Box3 | null;
	/** A connector frame of a part, in part coordinates. */
	connector(part: string, name: string, index?: number): { origin: THREE.Vector3; z: THREE.Vector3 } | null;
};

const worldBox = (scene: StepScene, ids: string[]) => {
	const box = new THREE.Box3();
	for (const id of ids) {
		const b = scene.bbox(id);
		if (b && !b.isEmpty()) box.union(b.clone().applyMatrix4(scene.pose(id)));
	}
	return box;
};

/** How far a box reaches along a unit axis. */
const extent = (b: THREE.Box3, axis: THREE.Vector3) => {
	const s = b.getSize(new THREE.Vector3());
	return Math.abs(s.x * axis.x) + Math.abs(s.y * axis.y) + Math.abs(s.z * axis.z);
};

/** Lay out every step's motion. */
export function planSteps(build: BuildInfo, scene: StepScene, sourcePart: (id: string) => string): PlannedStep[] {
	const all = worldBox(scene, build.steps.flatMap((s) => s.parts));
	const R = all.isEmpty() ? 50 : Math.max(all.getBoundingSphere(new THREE.Sphere()).radius, 1);
	return build.steps.map((s) => {
		// a subassembly moves as one; otherwise each copy on its own, `stagger` apart
		const units = s.group ? [s.parts] : s.parts.map((id) => [id]);
		const dur = s.duration ?? STEP_DURATION;
		const stagger = s.stagger ?? 0;
		const moves = units.map((ids, i): CopyMotion => {
			const box = worldBox(scene, ids);
			const center = box.isEmpty() ? new THREE.Vector3().setFromMatrixPosition(scene.pose(ids[0])) : box.getCenter(new THREE.Vector3());
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
						const m = scene.pose(owner);
						pivot = f.origin.clone().applyMatrix4(m);
						axis = f.z.clone().transformDirection(m);
					}
				}
				path = [axis.clone().multiplyScalar(s.distance ?? auto(axis)), new THREE.Vector3()];
			} else path = [axis.clone().multiplyScalar(auto(axis)), new THREE.Vector3()];
			return { ids, delay: i * stagger, dur, path, axis, pivot, turn: THREE.MathUtils.degToRad(s.turn ?? 0), center };
		});
		const length = Math.max(0.2, ...moves.map((m) => m.delay + m.dur));
		return { title: s.title, description: s.description, parts: s.parts, auto: s.auto, source: s.source, length, moves };
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
	const g = Math.max(1e-3, easeOut(Math.min(1, u / 0.22)));
	// grow about its centre, turn about its axis, then move along the path
	out.makeTranslation(-m.center.x, -m.center.y, -m.center.z);
	out.premultiply(tmp.s.makeScale(g, g, g));
	out.premultiply(tmp.m.makeTranslation(m.center.x - m.pivot.x, m.center.y - m.pivot.y, m.center.z - m.pivot.z));
	out.premultiply(tmp.m.makeRotationFromQuaternion(tmp.q.setFromAxisAngle(m.axis, m.turn * (1 - e))));
	const off = along(m.path, e, tmp.v);
	out.premultiply(tmp.m.makeTranslation(m.pivot.x + off.x, m.pivot.y + off.y, m.pivot.z + off.z));
	return out;
}

/** Where each copy is at timeline position `pos` (0..steps): its transform, or null while hidden. */
export function poseAt(steps: PlannedStep[], pos: number, each: (id: string, m: THREE.Matrix4 | null) => void) {
	const m = new THREE.Matrix4();
	steps.forEach((s, k) => {
		const t = (pos - k) * s.length;
		for (const mv of s.moves) {
			const u = pos >= k + 1 ? 1 : pos <= k ? 0 : (t - mv.delay) / mv.dur;
			const at = motionAt(mv, u, m);
			for (const id of mv.ids) each(id, at);
		}
	});
}
