import { describe, expect, it } from 'vitest';
import { pairReadouts } from './measure';

const face = (surface: string, center: [number, number, number], normal: [number, number, number], extra = {}) => ({ surface, area: 1, center, normal, ...extra });
const results = {
	p: {
		faces: [face('plane', [0, 0, 0], [0, 0, 1]), face('plane', [30, 0, 5], [0, 0, -1]), face('plane', [0, 0, 5], [1, 0, 0]), face('cylinder', [20, 0, 7], [1, 0, 0], { axis: [0, 1, 0], origin: [20, 0, 9], radius: 2 })],
		edges: [{ curve: 'line', length: 4, mid: [40, 0, 3], direction: [1, 0, 0] }],
		vertices: []
	}
} as never;
const min = { distance: 1, a: [0, 0, 0] as [number, number, number], b: [0, 0, 1] as [number, number, number] };
const parallel = (a: number, b: number) => pairReadouts([{ part: 'p', kind: 'face', index: a } as never, b < 0 ? ({ part: 'p', kind: 'edge', index: 0 } as never) : ({ part: 'p', kind: 'face', index: b } as never)], min, results).find((r) => r.key === 'parallel');

describe('parallel distance', () => {
	it('measures between parallel planes, even when offset', () => expect(parallel(0, 1)).toMatchObject({ value: '5', a: [30, 0, 0], b: [30, 0, 5] }));
	it('measures a plane to a parallel cylinder axis and line edge', () => {
		expect(parallel(0, 3)?.value).toBe('9');
		expect(parallel(0, -1)?.value).toBe('3');
	});
	it('is absent when not parallel', () => expect(parallel(0, 2)).toBeUndefined());
});
