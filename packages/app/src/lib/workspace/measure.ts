// Readouts for the measurement card: what the selection measures, each value named so it's
// clear what it is (closest points vs. center to center vs. farthest points).
import type { EntityRef } from '@parasocial/viewer';
import type { WorkspaceState } from './state.svelte';
import { num } from '$lib/format';

type V = [number, number, number];

export type Readout = {
	key: string;
	label: string;
	value: string;
	unit: string;
	/** endpoints of the dimension line drawn when this readout is active */
	a?: V;
	b?: V;
};

type Results = WorkspaceState['results'];

const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V) => Math.hypot(a[0], a[1], a[2]);
const onLine = (q: V, p: V, d: V): V => add(p, scale(d, dot(sub(q, p), d) / dot(d, d)));

/** Where an entity's "center" is: a circle's center point, or a cylinder's axis. */
type Anchor = { kind: 'point'; p: V; circle?: { r: number; n: V } } | { kind: 'axis'; p: V; d: V };

/** Part coordinates -> world (assembly poses); `dir` for directions. */
export type Place = (part: string, v: V, dir?: boolean) => V;
const unplaced: Place = (_p, v) => v;

function anchorOf(ref: EntityRef, results: Results, place: Place): Anchor | null {
	const a = anchorLocal(ref, results);
	if (!a) return null;
	const at = (v: V) => place(ref.part, v);
	const d = (v: V) => place(ref.part, v, true);
	return a.kind === 'axis' ? { kind: 'axis', p: at(a.p), d: d(a.d) } : { kind: 'point', p: at(a.p), circle: a.circle && { r: a.circle.r, n: d(a.circle.n) } };
}

function anchorLocal(ref: EntityRef, results: Results): Anchor | null {
	const r = results[ref.part];
	if (!r) return null;
	if (ref.kind === 'edge') {
		const e = r.edges[ref.index];
		if (e && (e.curve === 'circle' || e.curve === 'ellipse') && e.center) return { kind: 'point', p: e.center, circle: e.radius && e.axis ? { r: e.radius, n: e.axis } : undefined };
	}
	if (ref.kind === 'face') {
		const f = r.faces[ref.index];
		// anchor the axis beside the face (its centroid projected on), so the dimension line stays near it
		if (f && (f.surface === 'cylinder' || f.surface === 'cone') && f.axis) return { kind: 'axis', p: onLine(f.center, f.origin ?? f.center, f.axis), d: f.axis };
	}
	if (ref.kind === 'vertex') {
		const v = r.vertices?.[ref.index];
		if (v) return { kind: 'point', p: v };
	}
	return null;
}

function directionOf(ref: EntityRef, results: Results): V | undefined {
	const r = results[ref.part];
	if (ref.kind === 'face') {
		const f = r?.faces[ref.index];
		return f?.surface === 'plane' ? f.normal : f?.axis;
	}
	if (ref.kind === 'edge') return r?.edges[ref.index]?.direction;
}

const isCenter = (a: Anchor) => a.kind === 'axis' || !!a.circle;
const centerWord = (a: Anchor) => (a.kind === 'axis' ? 'axis' : a.circle ? 'center' : 'point');

/** Readouts for a pair, given the kernel's minimum distance and its closest points. */
export function pairReadouts(sel: EntityRef[], min: { distance: number; a: V; b: V }, results: Results, place: Place = unplaced): Readout[] {
	const out: Readout[] = [{ key: 'min', label: 'Minimum distance', value: num(min.distance, 2), unit: 'mm', a: min.a, b: min.b }];
	const A = anchorOf(sel[0], results, place),
		B = anchorOf(sel[1], results, place);
	if (A && B && (isCenter(A) || isCenter(B))) {
		let a: V | null = null,
			b: V | null = null;
		if (A.kind === 'point' && B.kind === 'point') (a = A.p), (b = B.p);
		else if (A.kind === 'point' && B.kind === 'axis') (a = A.p), (b = onLine(A.p, B.p, B.d));
		else if (A.kind === 'axis' && B.kind === 'point') (a = onLine(B.p, A.p, A.d)), (b = B.p);
		else if (A.kind === 'axis' && B.kind === 'axis' && Math.abs(dot(A.d, B.d)) / (len(A.d) * len(B.d)) > 0.9999) (a = A.p), (b = onLine(A.p, B.p, B.d));
		if (a && b) {
			const w = centerWord(A);
			const label = `${w[0].toUpperCase()}${w.slice(1)} to ${centerWord(B)}`; // "Center to center", "Axis to axis", …
			const d = len(sub(b, a));
			out.push({ key: 'center', label, value: num(d, 2), unit: 'mm', a, b });
			// two coplanar circles: the farthest points too, so all three readings are on the table
			const ca = A.kind === 'point' ? A.circle : undefined,
				cb = B.kind === 'point' ? B.circle : undefined;
			if (ca && cb && d > 1e-6) {
				const u = scale(sub(b, a), 1 / d);
				const parallel = Math.abs(dot(ca.n, cb.n)) / (len(ca.n) * len(cb.n)) > 0.9999;
				const coplanar = Math.abs(dot(sub(b, a), ca.n)) / len(ca.n) < 1e-6 * Math.max(1, d);
				if (parallel && coplanar) out.push({ key: 'max', label: 'Maximum distance', value: num(d + ca.r + cb.r, 2), unit: 'mm', a: sub(a, scale(u, ca.r)), b: add(b, scale(u, cb.r)) });
			}
		}
	}
	const d0 = directionOf(sel[0], results),
		d1 = directionOf(sel[1], results);
	const da = d0 && place(sel[0].part, d0, true),
		db = d1 && place(sel[1].part, d1, true);
	if (da && db) {
		const c = Math.min(1, Math.abs(dot(da, db)) / (len(da) * len(db)));
		out.push({ key: 'angle', label: 'Angle', value: num((Math.acos(c) * 180) / Math.PI, 1), unit: '°' });
	}
	return out;
}

/** Readouts for one entity, or a count for a larger selection. */
export function singleReadouts(sel: EntityRef[], results: Results): Readout[] {
	if (sel.length > 2) {
		const kinds = new Set(sel.map((s) => s.kind));
		return [{ key: 'count', label: 'Selected', value: `${sel.length} ${kinds.size === 1 ? [...kinds][0] + 's' : 'items'}`, unit: '' }];
	}
	if (sel.length !== 1) return [];
	const s = sel[0];
	const r = results[s.part];
	if (!r) return [];
	if (s.kind === 'face') {
		const f = r.faces[s.index];
		if (!f) return [];
		const out: Readout[] = [];
		if (f.radius && (f.surface === 'cylinder' || f.surface === 'sphere')) out.push({ key: 'radius', label: 'Radius', value: num(f.radius, 2), unit: 'mm' }, { key: 'diameter', label: 'Diameter', value: num(f.radius * 2, 2), unit: 'mm' });
		out.push({ key: 'area', label: 'Area', value: num(f.area, 2), unit: 'mm²' });
		return out;
	}
	if (s.kind === 'edge') {
		const e = r.edges[s.index];
		if (!e) return [];
		if (e.curve === 'circle' && e.radius) return [{ key: 'radius', label: 'Radius', value: num(e.radius, 2), unit: 'mm' }, { key: 'diameter', label: 'Diameter', value: num(e.radius * 2, 2), unit: 'mm' }];
		return [{ key: 'length', label: 'Length', value: num(e.length, 2), unit: 'mm' }];
	}
	return [];
}
