import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import type { BuildInfo } from '@parasocial/runtime/protocol';
import { motionAt, planSteps, poseAt, type StepScene } from './steps-motion';

const scene: StepScene = {
	pose: () => new THREE.Matrix4(),
	bbox: () => new THREE.Box3(new THREE.Vector3(-5, -5, 0), new THREE.Vector3(5, 5, 10)),
	connector: () => ({ origin: new THREE.Vector3(0, 0, 10), z: new THREE.Vector3(1, 0, 0) })
};
const build = (steps: BuildInfo['steps']): BuildInfo => ({ id: 'b', file: 'builds/b.ts', export: 'default', name: 'B', assembly: 'a', steps, problems: [] });
const at = (m: THREE.Matrix4 | null, p = new THREE.Vector3(5, 0, 0)) => m && p.clone().applyMatrix4(m).toArray().map((x) => Math.round(x * 1000) / 1000 + 0);

describe('build step motion', () => {
	test('hidden before its step, in place after, on its path between', () => {
		const [s] = planSteps(build([{ title: 'A', parts: ['a/p'], from: [[0, 0, 40]] }]), scene, (id) => id);
		const m = s.moves[0];
		expect(motionAt(m, 0)).toBeNull();
		expect(at(motionAt(m, 1))).toEqual([5, 0, 0]);
		// halfway along a straight path (eased: exactly half at u = 0.5), fully grown
		expect(at(motionAt(m, 0.5))).toEqual([5, 0, 20]);
	});

	test('along a connector: its axis from its origin, turning about it', () => {
		const [s] = planSteps(build([{ title: 'A', parts: ['a/p'], along: { part: 'p', connector: 'c' }, distance: 30, turn: 180 }]), scene, () => 'p');
		const m = s.moves[0];
		expect(m.axis.toArray()).toEqual([1, 0, 0]);
		expect(m.pivot.toArray()).toEqual([0, 0, 10]);
		// halfway: 15 out along +X and a quarter turn about the axis through (0, 0, 10)
		expect(at(motionAt(m, 0.5), new THREE.Vector3(0, 0, 0))).toEqual([15, 10, 10]);
	});

	test('staggered copies start one after another; the timeline places each', () => {
		const steps = planSteps(build([{ title: 'A', parts: ['a/1'] }, { title: 'B', parts: ['a/2', 'a/3'], stagger: 0.6, duration: 1 }]), scene, (id) => id);
		expect(steps[1].length).toBeCloseTo(1.6);
		const seen: Record<string, THREE.Matrix4 | null> = {};
		poseAt(steps, 1.3, (id, m) => (seen[id] = m && m.clone()));
		expect(seen['a/1']?.equals(new THREE.Matrix4())).toBe(true);
		expect(seen['a/2']).not.toBeNull();
		expect(seen['a/3']).toBeNull();
	});
});
