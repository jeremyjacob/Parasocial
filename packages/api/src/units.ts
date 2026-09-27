// Units and expressions (PLAN §5 Units, §8 Parameters). Pure TS, shared by the worker and the UI.
// Every numeric input accepts a unit (`"1/4 in"`, `"3mm"`, `"30 deg"`) and expressions
// (`"=width/2"`, `"2 * (t + 1)"`). No `eval`: a small recursive-descent parser.

export type Unit = { readonly kind: "length" | "angle" | "none"; readonly symbol: string; readonly factor: number };

const u = (kind: Unit["kind"], symbol: string, factor: number): Unit => Object.freeze({ kind, symbol, factor });

// factor converts to base units: mm for length, degrees for angle.
export const mm = u("length", "mm", 1);
export const cm = u("length", "cm", 10);
export const m = u("length", "m", 1000);
export const inch = u("length", "in", 25.4);
export const ft = u("length", "ft", 304.8);
export const deg = u("angle", "deg", 1);
export const rad = u("angle", "rad", 180 / Math.PI);
export const unitless = u("none", "", 1);

export const UNITS: Record<string, Unit> = {
  mm,
  cm,
  m,
  in: inch,
  inch,
  '"': inch,
  ft,
  "'": ft,
  deg,
  "°": deg,
  rad,
};

export type DocUnits = { length: Unit; angle: Unit };
export const SI_DEFAULT: DocUnits = { length: mm, angle: deg };

export class ExprError extends Error {}

type Tok = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
    if (num) {
      out.push({ t: "num", v: parseFloat(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) {
      out.push({ t: "id", v: id[0] });
      i += id[0].length;
      continue;
    }
    if ("+-*/^(),%".includes(c) || c === '"' || c === "'" || c === "°") {
      out.push({ t: "op", v: c });
      i++;
      continue;
    }
    throw new ExprError(`unexpected "${c}"`);
  }
  return out;
}

const FUNCS: Record<string, (...a: number[]) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  // trig takes degrees, like the rest of the API
  sin: (x) => Math.sin((x * Math.PI) / 180),
  cos: (x) => Math.cos((x * Math.PI) / 180),
  tan: (x) => Math.tan((x * Math.PI) / 180),
  atan2: (y, x) => (Math.atan2(y, x) * 180) / Math.PI,
};
const CONSTS: Record<string, number> = { pi: Math.PI, PI: Math.PI, e: Math.E };

export type EvalEnv = {
  /** Variables (other params), already in base units. */
  vars?: Record<string, number>;
  /** Unit applied to bare numbers (the param's unit, or doc length unit). */
  defaultUnit?: Unit;
};

/** A quantity during evaluation: value in base units, and whether it carried an explicit unit. */
type Q = { v: number; dim: Unit["kind"] | null };

/**
 * Evaluate an expression or unit string to base units (mm / degrees).
 * `"1/4 in"` -> 6.35, `"=width/2"` with vars {width: 40} -> 20, `"30"` with defaultUnit inch -> 762.
 */
export function evaluate(input: string | number, env: EvalEnv = {}): number {
  if (typeof input === "number") return input * (env.defaultUnit?.factor ?? 1);
  let src = input.trim();
  if (src.startsWith("=")) src = src.slice(1);
  if (!src) throw new ExprError("empty expression");
  const toks = lex(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.t === "op" && peek()!.v === v;
  const du = env.defaultUnit ?? unitless;

  // Bare numbers take the default unit unless a unit follows. Vars are already base units.
  const primary = (): Q => {
    const t = peek();
    if (!t) throw new ExprError("unexpected end of expression");
    if (t.t === "op" && t.v === "(") {
      p++;
      const q = sum();
      if (!isOp(")")) throw new ExprError("missing )");
      p++;
      return q;
    }
    if (t.t === "op" && (t.v === "-" || t.v === "+")) {
      p++;
      const q = unary();
      return { v: t.v === "-" ? -q.v : q.v, dim: q.dim };
    }
    if (t.t === "num") {
      p++;
      return { v: t.v, dim: null };
    }
    if (t.t === "id") {
      p++;
      if (FUNCS[t.v] && isOp("(")) {
        p++;
        const args: Q[] = [];
        if (!isOp(")")) {
          args.push(sum());
          while (isOp(",")) {
            p++;
            args.push(sum());
          }
        }
        if (!isOp(")")) throw new ExprError(`missing ) after ${t.v}(`);
        p++;
        const vals = args.map((a) => a.v);
        const dim = ["sqrt", "abs", "min", "max", "round", "floor", "ceil"].includes(t.v) ? (args[0]?.dim ?? null) : "none";
        return { v: FUNCS[t.v](...vals), dim: dim as Q["dim"] };
      }
      if (t.v in CONSTS) return { v: CONSTS[t.v], dim: "none" };
      if (env.vars && t.v in env.vars) return { v: env.vars[t.v], dim: "length" };
      throw new ExprError(`unknown name "${t.v}"`);
    }
    throw new ExprError(`unexpected "${t.v}"`);
  };
  const trailingUnit = (): Unit | null => {
    const t = peek();
    if (!t) return null;
    if (t.t === "id" && UNITS[t.v]) {
      p++;
      return UNITS[t.v];
    }
    if (t.t === "op" && (t.v === '"' || t.v === "'" || t.v === "°")) {
      p++;
      return UNITS[t.v];
    }
    return null;
  };
  const power = (): Q => {
    const a = primary();
    if (isOp("^")) {
      p++;
      const b = unary();
      return { v: Math.pow(a.v, b.v), dim: a.dim };
    }
    return a;
  };
  const unary = (): Q => power();
  // Units bind to the running product: `1/4 in` = (1/4) in, `2 * 3 in` = 6 in, `2in * 3` = 6 in.
  const product = (): Q => {
    let a = withUnit(unary());
    for (;;) {
      if (isOp("*")) {
        p++;
        const b = unary();
        a = withUnit({ v: a.v * b.v, dim: a.dim ?? b.dim });
      } else if (isOp("/")) {
        p++;
        const b = unary();
        if (b.v === 0) throw new ExprError("division by zero");
        a = withUnit({ v: a.v / b.v, dim: a.dim && b.dim && a.dim === b.dim ? "none" : (a.dim ?? null) });
      } else if (isOp("%")) {
        p++;
        a = { v: a.v / 100, dim: a.dim };
      } else return a;
    }
  };
  const withUnit = (q: Q): Q => {
    if (q.dim !== null) return q;
    const unit = trailingUnit();
    return unit ? { v: q.v * unit.factor, dim: unit.kind } : q;
  };
  const sum = (): Q => {
    let a = product();
    for (;;) {
      if (isOp("+")) {
        p++;
        const b = product();
        a = addQ(a, b, 1);
      } else if (isOp("-")) {
        p++;
        const b = product();
        a = addQ(a, b, -1);
      } else return a;
    }
  };
  const addQ = (a: Q, b: Q, s: number): Q => {
    // a bare number next to a dimensioned one takes the default unit
    const av = a.dim === null ? a.v * du.factor : a.v;
    const bv = b.dim === null ? b.v * du.factor : b.v;
    if (a.dim === null && b.dim === null) return { v: a.v + s * b.v, dim: null };
    return { v: av + s * bv, dim: a.dim ?? b.dim };
  };
  const q = sum();
  if (p < toks.length) throw new ExprError(`unexpected "${(toks[p] as any).v}"`);
  if (!Number.isFinite(q.v)) throw new ExprError("result is not a finite number");
  return q.dim === null ? q.v * du.factor : q.v;
}

/** Try to evaluate; returns null instead of throwing. */
export function tryEvaluate(input: string | number, env: EvalEnv = {}): number | null {
  try {
    return evaluate(input, env);
  } catch {
    return null;
  }
}

/** Format a base-unit value in a unit, trimming trailing zeros. */
export function formatValue(v: number, unit: Unit = mm, digits = 3): string {
  const x = v / unit.factor;
  const s = Number(x.toFixed(digits)).toString();
  return unit.symbol ? `${s} ${unit.symbol}` : s;
}
