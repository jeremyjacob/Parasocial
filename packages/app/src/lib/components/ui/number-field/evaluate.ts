/**
 * Pluggable evaluator for NumberField.
 *
 * NumberField only knows `Evaluator = (text) => EvalResult`. The default implementation here is a
 * tiny, safe (no eval) recursive-descent parser that understands:
 *   - numbers:            12, 12.5, .5, 1e3
 *   - arithmetic:         + - * / ^ and parentheses
 *   - formulas:           =width/2  (leading "=" is optional; identifiers resolve from `scope`)
 *   - units:              12mm, 1.5 in, 3", 2ft, 1/4 in  (converted into the field's base unit)
 *   - functions:          min, max, abs, round, floor, ceil, sqrt, sin, cos, tan (degrees)
 *
 * Unit binding rule: if the only unit in the input is a trailing one ("1/4 in", "10 + 2 in"),
 * it applies to the whole expression; otherwise each unit binds to the number before it
 * ("1in + 2mm").
 *
 * The workspace will swap in an evaluator backed by the document's params and unit system.
 */

export type EvalResult =
	| {
			ok: true;
			value: number;
			/** Present when the input was more than a plain number: store it as typed. */
			expression?: string;
	  }
	| { ok: false; error: string };

export type Evaluator = (input: string) => EvalResult;

export interface EvaluatorOptions {
	/** Named values available to formulas (`=width/2`). */
	scope?: Record<string, number>;
	/** Unit → factor into the base unit. Default: length units with mm as base. */
	units?: Record<string, number>;
	/** The base unit symbol; "12 mm" in a mm field is still a plain number. */
	baseUnit?: string;
}

export const lengthUnitsMm: Record<string, number> = {
	mm: 1,
	cm: 10,
	m: 1000,
	in: 25.4,
	'"': 25.4,
	ft: 304.8,
	"'": 304.8,
	um: 0.001,
	µm: 0.001
};

export const angleUnitsDeg: Record<string, number> = {
	deg: 1,
	'°': 1,
	rad: 180 / Math.PI
};

const FUNCS: Record<string, (...a: number[]) => number> = {
	min: Math.min,
	max: Math.max,
	abs: Math.abs,
	round: Math.round,
	floor: Math.floor,
	ceil: Math.ceil,
	sqrt: Math.sqrt,
	sin: (d) => Math.sin((d * Math.PI) / 180),
	cos: (d) => Math.cos((d * Math.PI) / 180),
	tan: (d) => Math.tan((d * Math.PI) / 180)
};

type Tok =
	| { t: 'num'; v: number }
	| { t: 'id'; v: string }
	| { t: 'op'; v: string }
	| { t: 'unit'; v: string };

class EvalError extends Error {}

function tokenize(src: string, units: Record<string, number>): Tok[] {
	const out: Tok[] = [];
	let i = 0;
	const unitSymbols = Object.keys(units)
		.filter((u) => !/^[a-zµ]+$/i.test(u))
		.sort((a, b) => b.length - a.length);
	while (i < src.length) {
		const c = src[i];
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
		if (num) {
			out.push({ t: 'num', v: parseFloat(num[0]) });
			i += num[0].length;
			continue;
		}
		const id = /^[a-zµ_][\w.]*/i.exec(src.slice(i));
		if (id) {
			const prev = out[out.length - 1];
			const isUnit = id[0] in units && prev && (prev.t === 'num' || (prev.t === 'op' && prev.v === ')'));
			out.push(isUnit ? { t: 'unit', v: id[0] } : { t: 'id', v: id[0] });
			i += id[0].length;
			continue;
		}
		const sym = unitSymbols.find((u) => src.startsWith(u, i));
		if (sym) {
			out.push({ t: 'unit', v: sym });
			i += sym.length;
			continue;
		}
		if ('+-*/^(),×÷'.includes(c)) {
			out.push({ t: 'op', v: c === '×' ? '*' : c === '÷' ? '/' : c });
			i++;
			continue;
		}
		throw new EvalError(`Unexpected “${c}”`);
	}
	return out;
}

function parse(tokens: Tok[], scope: Record<string, number>, units: Record<string, number>): number {
	let pos = 0;
	const peek = () => tokens[pos];
	const isOp = (v: string) => {
		const t = peek();
		return t?.t === 'op' && t.v === v;
	};

	function expr(): number {
		let v = term();
		while (isOp('+') || isOp('-')) {
			const op = (tokens[pos++] as { v: string }).v;
			const r = term();
			v = op === '+' ? v + r : v - r;
		}
		return v;
	}
	function term(): number {
		let v = power();
		while (isOp('*') || isOp('/')) {
			const op = (tokens[pos++] as { v: string }).v;
			const r = power();
			if (op === '/' && r === 0) throw new EvalError('Division by zero');
			v = op === '*' ? v * r : v / r;
		}
		return v;
	}
	function power(): number {
		const base = unary();
		if (isOp('^')) {
			pos++;
			return Math.pow(base, power());
		}
		return base;
	}
	function unary(): number {
		if (isOp('-')) {
			pos++;
			return -unary();
		}
		if (isOp('+')) {
			pos++;
			return unary();
		}
		return withUnit(primary());
	}
	function withUnit(v: number): number {
		const t = peek();
		if (t?.t === 'unit') {
			pos++;
			return v * units[t.v];
		}
		return v;
	}
	function primary(): number {
		const t = tokens[pos++];
		if (!t) throw new EvalError('Incomplete expression');
		if (t.t === 'num') return t.v;
		if (t.t === 'op' && t.v === '(') {
			const v = expr();
			if (!isOp(')')) throw new EvalError('Missing “)”');
			pos++;
			return v;
		}
		if (t.t === 'id') {
			const fn = FUNCS[t.v.toLowerCase()];
			if (fn && isOp('(')) {
				pos++;
				const args = [expr()];
				while (isOp(',')) {
					pos++;
					args.push(expr());
				}
				if (!isOp(')')) throw new EvalError('Missing “)”');
				pos++;
				return fn(...args);
			}
			if (t.v in scope) return scope[t.v];
			throw new EvalError(`Unknown name “${t.v}”`);
		}
		if (t.t === 'unit') throw new EvalError(`Unit “${t.v}” needs a number`);
		throw new EvalError(`Unexpected “${t.v}”`);
	}

	const v = expr();
	if (pos < tokens.length) {
		const t = tokens[pos];
		throw new EvalError(`Unexpected “${t.v}”`);
	}
	return v;
}

export function createEvaluator(options: EvaluatorOptions = {}): Evaluator {
	const units = options.units ?? lengthUnitsMm;
	const scope = options.scope ?? {};
	const baseUnit = options.baseUnit ?? 'mm';
	const plain = new RegExp(`^\\s*-?(\\d+\\.?\\d*|\\.\\d+)\\s*(${escapeRe(baseUnit)})?\\s*$`);

	return (input: string): EvalResult => {
		const raw = input.trim();
		if (!raw) return { ok: false, error: 'Enter a value' };
		const src = raw.startsWith('=') ? raw.slice(1) : raw;
		try {
			let tokens = tokenize(src, units);
			if (!tokens.length) return { ok: false, error: 'Enter a value' };

			// Trailing-unit rule: a single unit at the end scales the whole expression.
			const unitIdx = tokens.flatMap((t, i) => (t.t === 'unit' ? [i] : []));
			let factor = 1;
			if (unitIdx.length === 1 && unitIdx[0] === tokens.length - 1 && tokens.length > 2) {
				factor = units[(tokens[unitIdx[0]] as { v: string }).v];
				tokens = tokens.slice(0, -1);
			}
			const value = parse(tokens, scope, units) * factor;
			if (!Number.isFinite(value)) return { ok: false, error: 'Not a finite number' };
			const isPlain = plain.test(raw);
			return isPlain ? { ok: true, value } : { ok: true, value, expression: raw };
		} catch (e) {
			return { ok: false, error: e instanceof EvalError ? e.message : 'Invalid expression' };
		}
	};
}

function escapeRe(s: string) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Decimal places needed to represent `n` (0.25 → 2). */
export function decimalsOf(n: number): number {
	if (!Number.isFinite(n)) return 0;
	const s = String(n);
	if (s.includes('e-')) return parseInt(s.split('e-')[1], 10);
	const d = s.split('.')[1];
	return d ? d.length : 0;
}

/** Format for display: up to `precision` decimals, trailing zeros trimmed, tabular-friendly. */
export function formatNumber(n: number, precision: number): string {
	const fixed = n.toFixed(Math.min(Math.max(precision, 0), 10));
	const trimmed = fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
	return trimmed === '-0' ? '0' : trimmed;
}

/** Round away float noise from repeated stepping (0.1 + 0.2). */
export function roundTo(n: number, decimals: number): number {
	const f = Math.pow(10, Math.min(decimals, 10));
	return Math.round(n * f) / f;
}

export function clamp(n: number, min = -Infinity, max = Infinity): number {
	return Math.min(max, Math.max(min, n));
}
