import { describe, expect, it } from 'vitest';
import { angleUnitsDeg, createEvaluator, formatNumber } from './evaluate';

const ev = createEvaluator({ scope: { width: 120, thickness: 3 } });
const value = (s: string) => {
	const r = ev(s);
	if (!r.ok) throw new Error(r.error);
	return r.value;
};

describe('default evaluator', () => {
	it('parses plain numbers without storing an expression', () => {
		expect(ev('12.5')).toEqual({ ok: true, value: 12.5 });
		expect(ev('12 mm')).toEqual({ ok: true, value: 12 });
	});

	it('does arithmetic with precedence and parentheses', () => {
		expect(value('2 + 3 * 4')).toBe(14);
		expect(value('(2 + 3) * 4')).toBe(20);
		expect(value('2^3')).toBe(8);
		expect(value('-4 + 1')).toBe(-3);
	});

	it('resolves formulas from scope and keeps the text as typed', () => {
		expect(ev('=width/2')).toEqual({ ok: true, value: 60, expression: '=width/2' });
		expect(value('thickness * 2')).toBe(6);
	});

	it('converts units into the base unit', () => {
		expect(value('1 in')).toBeCloseTo(25.4);
		expect(value('1/4 in')).toBeCloseTo(6.35);
		expect(value('1in + 2mm')).toBeCloseTo(27.4);
		expect(value('2 cm')).toBe(20);
		expect(value('3"')).toBeCloseTo(76.2);
	});

	it('reports errors instead of throwing', () => {
		expect(ev('=widht/2')).toEqual({ ok: false, error: 'Unknown name “widht”' });
		expect(ev('1/0').ok).toBe(false);
		expect(ev('(1 + 2').ok).toBe(false);
		expect(ev('').ok).toBe(false);
	});

	it('supports other unit systems', () => {
		const deg = createEvaluator({ units: angleUnitsDeg, baseUnit: 'deg' });
		const r = deg('90deg');
		expect(r.ok && r.value).toBe(90);
	});

	it('formats with trimmed trailing zeros', () => {
		expect(formatNumber(2.5, 2)).toBe('2.5');
		expect(formatNumber(3, 2)).toBe('3');
		expect(formatNumber(-0.0001, 2)).toBe('0');
	});
});
