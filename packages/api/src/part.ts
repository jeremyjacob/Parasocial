// part(), param() and running a part in a context.
import type { OpRecord } from "@parasocial/naming";
import { noteKernelFault } from "@parasocial/kernel";
import { ctx, withContext, PartContext, shortLoc } from "./context";
import { OpError, userError } from "./op";
import { Solid } from "./solid";
import type { Appearance, ColorSpec, Material, ParamDecl, Problem } from "./types";
import { evaluate, UNITS, type Unit } from "./units";
import type { ConnectorFrame } from "./connector";
import type { Instance } from "./assembly";

export type PartTools = {
  color: {
    /** Next color from the curated part palette (round-robin by part order). */
    auto(): ColorSpec;
    /** A specific hex color, e.g. `"#4a7bd0"`. Pass it to `.color()`; opacity goes in `.opacity()` / `.appearance()`. */
    rgb(hex: string): ColorSpec;
  };
};

export type PartBody = (tools: PartTools) => Solid;

export type PartDef = {
  readonly __part: true;
  readonly name: string;
  readonly body: PartBody;
  /**
   * A connector of this part, for assembly joints: `revolute(body, lid, lid.at("hinge"))`, or
   * connector to connector, `revolute(chassis.at("axle"), wheel.at("hub"))`. `index` picks one
   * frame of a connector declared on several (a pattern of holes): `base.at("bolt", 2)`.
   */
  at(connector: string, index?: number): ConnectorRef;
};

/** A named connector on a part (declared in its body with `.connector(name, ...)`), or on a copy of one. */
export type ConnectorRef = {
  readonly __connector: true;
  readonly part: PartDef;
  readonly name: string;
  /** Which frame of a connector declared on several (0-based). */
  readonly index?: number;
  /** The copy it's on (from `insert`); none for the part itself. */
  readonly instance?: Instance;
};

/** @internal Check a connector name and index (shared by parts and their copies). */
export function connectorRef(part: PartDef, what: string, connector: string, index?: number, instance?: Instance): ConnectorRef {
  if (typeof connector !== "string" || !connector) throw new Error(`${what}.at(name): name the connector, e.g. .at("hinge")`);
  if (index !== undefined && !(Number.isInteger(index) && index >= 0)) throw new Error(`${what}.at("${connector}", index): index must be a whole number from 0`);
  return Object.freeze({ __connector: true as const, part, name: connector, ...(index !== undefined && { index }), ...(instance && { instance }) });
}

/**
 * Declare a part. A studio (`studios/*.ts`) exports one or more:
 * `export default part("Bracket", () => sketch(plane.XY).rect(40, 25).extrude(3))` (part id `bracket`),
 * or several as named exports, `export const lid = part("Lid", () => ...)` in `studios/case.ts`
 * (part id `case:lid`). Each part regenerates on its own, with its own params, color and ops.
 * The studio's display name is `export const name = "Case"` (the file name when absent).
 */
export function part(name: string, body: PartBody): PartDef {
  if (typeof name !== "string" || !name.trim()) throw new Error('part(name, body): name must be a non-empty string, e.g. part("Bracket", () => ...)');
  if (typeof body !== "function") throw new Error("part(name, body): body must be a function returning a solid");
  const def: PartDef = Object.freeze({
    __part: true as const,
    name,
    body,
    at(connector: string, index?: number): ConnectorRef {
      return connectorRef(def, name, connector, index);
    },
  });
  return def;
}

export type ParamOptions = {
  min?: number;
  max?: number;
  step?: number;
  /** Unit of the default and of UI input; the returned value is converted to base units (mm, deg). */
  unit?: Unit;
  /** Discrete choices (numbers or strings). */
  options?: (number | string)[];
  /** What the params panel shows: short, plain language, sentence case, no abbreviations ("Rope diameter" for `ropeD`). */
  label?: string;
  description?: string;
  /**
   * One value for the whole document: every part that declares this param (same name) reads the
   * same override. For dimensions several parts must agree on, like the link lengths of a closed
   * linkage. Declare it with the same default everywhere, e.g. in a lib/ helper.
   */
  shared?: boolean;
};

/**
 * Declare a parameter. The value in code is the **default**; the UI and agents can override it
 * per configuration. Returns the effective value, in base units (mm / degrees) for numbers.
 */
export function param(name: string, defaultValue: number, opts?: ParamOptions): number;
export function param<T extends string | number>(name: string, defaultValue: T, opts: ParamOptions & { options: T[] }): T;
export function param(name: string, defaultValue: number | string, opts: ParamOptions = {}): number | string {
  const c = ctx();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) userError(`param name "${name}" must be an identifier (letters, digits, _), so expressions can refer to it`);
  if (c.params.some((p) => p.name === name)) userError(`param "${name}" is declared twice in ${c.part}`);
  const site = c.frames()[0];
  const unit = opts.unit;
  const factor = unit?.factor ?? 1;
  const decl: ParamDecl = {
    name,
    part: c.part,
    default: defaultValue,
    value: defaultValue,
    unit: unit?.symbol,
    min: opts.min,
    max: opts.max,
    step: opts.step,
    options: opts.options,
    label: opts.label,
    description: opts.description,
    shared: opts.shared || undefined,
    source: site && { file: site.file, line: site.line, col: site.col },
    overridden: false,
  };
  if (typeof defaultValue === "number") {
    if (opts.min !== undefined && defaultValue < opts.min) userError(`param "${name}" default ${defaultValue} is below its min ${opts.min}`);
    if (opts.max !== undefined && defaultValue > opts.max) userError(`param "${name}" default ${defaultValue} is above its max ${opts.max}`);
  }
  let value: number | string = typeof defaultValue === "number" ? defaultValue * factor : defaultValue;
  const ov = opts.shared ? c.sharedOverrides[name] : c.overrides[name];
  if (ov !== undefined) {
    decl.expression = String(ov);
    try {
      let v: number | string;
      if (opts.options) {
        const match = opts.options.find((o) => String(o) === String(ov));
        if (match === undefined) throw new Error(`must be one of ${opts.options.join(", ")}`);
        v = typeof match === "number" ? match * factor : match;
      } else {
        const vars: Record<string, number> = { ...(c.options.paramHints ?? {}) };
        for (const p of c.params) if (typeof p.value === "number") vars[p.name] = p.value;
        // bare numbers are in the param's unit; the result is base units
        v = evaluate(ov, { vars, defaultUnit: unit ?? UNITS.mm });
        const inUnit = v / factor;
        if (opts.min !== undefined && inUnit < opts.min - 1e-9) throw new Error(`below the minimum ${opts.min}${unit ? " " + unit.symbol : ""}`);
        if (opts.max !== undefined && inUnit > opts.max + 1e-9) throw new Error(`above the maximum ${opts.max}${unit ? " " + unit.symbol : ""}`);
      }
      value = v;
      decl.overridden = true;
    } catch (e) {
      decl.error = `override "${ov}" rejected: ${(e as Error).message}`;
      c.problems.push({
        severity: "warning",
        kind: "param",
        message: `param "${name}" ${decl.error}; using the code default ${defaultValue} (${shortLoc(site)})`,
        part: c.part,
        source: decl.source,
      });
    }
  }
  decl.value = value;
  c.params.push(decl);
  return value;
}

export type PartRun = {
  part: string;
  name: string;
  ok: boolean;
  /** The final solid (or, after a failure, the last good one: §8 "the viewport never goes blank"). */
  record?: OpRecord;
  partial: boolean;
  color?: ColorSpec;
  appearance?: Appearance;
  material?: Material;
  /** Named frames for assembly joints (part coordinates): one per connector, or several for a pattern. */
  connectors?: Record<string, ConnectorFrame[]>;
  params: ParamDecl[];
  problems: Problem[];
  ops: OpRecord[];
  timings: { total: number; ops: number; cacheHits: number; cacheMisses: number };
};

const tools: PartTools = Object.freeze({
  color: Object.freeze({
    auto: (): ColorSpec => ({ kind: "auto" }),
    rgb: (hex: string): ColorSpec => ({ kind: "rgb", hex }),
  }),
});

/** Run a part body in a fresh context. Never throws for script errors: they become problems. */
export function runPart(def: PartDef, c: PartContext): PartRun {
  const first = runOnce(def, c);
  // an override referred to a param declared later: rerun with this pass's values (cheap: op cache)
  const forward = first.params.some((p) => p.error?.includes("unknown name") && first.params.some((q) => p.error!.includes(`"${q.name}"`)));
  if (!forward || c.options.paramHints) return first;
  const hints: Record<string, number> = {};
  for (const p of first.params) if (typeof p.value === "number") hints[p.name] = p.value;
  return runOnce(def, new PartContext({ ...c.options, paramHints: hints }));
}

function runOnce(def: PartDef, c: PartContext): PartRun {
  const t0 = performance.now();
  let out: Solid | undefined;
  let error: Problem | undefined;
  withContext(c, () => {
    try {
      out = def.body(tools);
      if (!(out instanceof Solid)) userError(`part "${def.name}" must return a solid (got ${out === undefined ? "nothing" : typeof out}); return the final shape from the body`);
    } catch (e) {
      error = toProblem(e, c);
    }
  });
  const lastGood = out?.record ?? lastSolidOf(c);
  if (error) c.problems.unshift(error);
  return {
    part: c.part,
    name: def.name,
    ok: !error,
    record: lastGood,
    partial: !!error,
    color: out?.meta.color,
    appearance: out?.meta.appearance,
    material: out?.meta.material,
    connectors: out?.meta.connectors,
    params: c.params,
    problems: c.problems,
    ops: c.ops,
    timings: { total: performance.now() - t0, ops: c.opTime, cacheHits: c.cache.hits, cacheMisses: c.cache.misses },
  };
}

function lastSolidOf(c: PartContext): OpRecord | undefined {
  for (let i = c.ops.length - 1; i >= 0; i--) if (c.ops[i].type !== "sketch") return c.ops[i];
  return undefined;
}

export function toProblem(e: unknown, c: PartContext): Problem {
  if (e instanceof OpError) return e.problem;
  // e.g. solid.volume() on garbage geometry trapped inside the kernel
  noteKernelFault(e);
  const err = e instanceof Error ? e : new Error(String(e));
  // runtime exception in user code: locate via the stack
  const frames = parseFrames(err, c);
  const site = frames[0];
  const loc = site ? ` (${shortLoc(site)})` : "";
  return {
    severity: "error",
    kind: "runtime",
    message: `${err.name && err.name !== "Error" ? err.name + ": " : ""}${err.message}${loc}`,
    part: c.part,
    source: site && { file: site.file, line: site.line, col: site.col },
  };
}

function parseFrames(err: Error, c: PartContext) {
  return c.frames(err.stack ?? "");
}
