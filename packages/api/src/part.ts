// part(), param() and running a part in a context.
/**
 * @module part — documents, studios, parts, params and stable names.
 *
 * A document is a set of TypeScript scripts: studios in studios/*.ts, shared helpers in lib/. A studio
 * exports one or more parts: `export default part("Name", () => solid)` is part id `<file>`; named
 * exports like `export const lid = part("Lid", ...)` in studios/case.ts are part id `case:lid`. Related
 * parts can share a studio and its helpers. `export const name = "Case"` gives the studio a display
 * name and `export const description = "Two-part shell with snap hinge"` a line saying more (the
 * Parts tree shows it on hover). Parts are modeled in place (where they sit in the product). A studio
 * exports parts or assemblies, never both.
 *
 * Names (studio, part, assembly) are labels in the Parts tree: 1–4 words, sentence case, naming what
 * the thing is ("Winch drum", "Stator mount"). No dashes or parentheticals, and no part numbers,
 * materials, revisions or status in a name; those go in `partNumber`, `material` and `description`
 * (`part()` and `assembly()` options, or the studio's `description` export).
 *
 * Params: `param(name, default, { label, min, max, step, unit, options, shared })`. The value in code is
 * the default; configurations override it (set_param never edits source; to change a default, edit the
 * script). Don't hardcode values that are params. `name` is an identifier expressions refer to
 * (`ropeD`); `label` is what the params panel shows: short, plain language, sentence case, no
 * abbreviations, under ~24 characters, without words the panel group already says (the part name):
 * `param("ropeD", 2, { label: "Rope diameter" })`. `{ shared: true }` makes one document-wide value
 * (every part declaring that name reads it; set it with part "*"), for dimensions several parts must agree on.
 *
 * Stable names: tag anything a human might point at; tags become part of stable names
 * (`bracket/base · side · outline/right`), which is how notes find their geometry after dimensions
 * change. Faces are `op · role · source`; edges are named by the faces around them
 * `(faceA) & (faceB)`; a split face keeps its name on every piece. Untagged operations get automatic
 * ids that can shift when you insert operations of the same type earlier in the same scope.
 *
 * Errors carry a source location and say what to do next ("fillet radius 5 exceeds adjacent face
 * width 3.2; use a value below 3.2 (bracket.ts:18)"); the workspace keeps the last good geometry.
 */
import type { OpRecord } from "@parasocial/naming";
import { noteKernelFault } from "@parasocial/kernel";
import { ctx, withContext, PartContext, shortLoc } from "./context";
import { OpError, userError, type OpTiming } from "./op";
import { Solid } from "./solid";
import type { Appearance, ColorSpec, Material, PartMeta, ParamDecl, Problem } from "./types";
import { MATERIALS } from "./solid";
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
  /** Part number, description, vendor, material (from `part(name, body, options)`). */
  readonly meta?: PartMeta;
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
 * The studio's display name is `export const name = "Case"` (the file name when absent); keep names
 * short and put details in options (`description`, `partNumber`, `material`), not the name.
 * Options say what the part is, for the bill of materials and drawings:
 * `part("Pin", () => ..., { material: "steel", partNumber: "PS-104", description: "Hinge pin Ø5", vendor: "McMaster", standard: true })`.
 */
export function part(name: string, body: PartBody, options?: PartOptions): PartDef {
  if (typeof name !== "string" || !name.trim()) throw new Error('part(name, body): name must be a non-empty string, e.g. part("Bracket", () => ...)');
  if (typeof body !== "function") throw new Error("part(name, body): body must be a function returning a solid");
  const meta = partMeta(name, options);
  const def: PartDef = Object.freeze({
    __part: true as const,
    name,
    body,
    ...(meta && { meta }),
    at(connector: string, index?: number): ConnectorRef {
      return connectorRef(def, name, connector, index);
    },
  });
  return def;
}

/** Optional third argument of `part()`: what the part is, for the bill of materials and drawings. */
export type PartOptions = {
  /** A name from MATERIALS ("aluminum", "steel", "pla", …) or `{ name, density }` (g/cm³). The BOM shows mass only when the density is known. */
  material?: Material | string;
  /** Part (or catalog) number; parts with the same number are one BOM line. */
  partNumber?: string;
  /** One line saying what it is, e.g. "M5×12 socket head cap screw". */
  description?: string;
  /** Who makes or sells it. */
  vendor?: string;
  /** Off-the-shelf (fastener, bearing): the BOM groups every copy by part number, else by name and vendor. */
  standard?: boolean;
};

function partMeta(name: string, o: PartOptions | undefined): PartMeta | undefined {
  if (o === undefined) return undefined;
  const what = `part("${name}", body, options)`;
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error(`${what}: options must be an object, e.g. { material: "steel", partNumber: "PS-104" }`);
  const known = ["material", "partNumber", "description", "vendor", "standard"];
  for (const k of Object.keys(o)) if (!known.includes(k)) throw new Error(`${what}: unknown option "${k}"; use ${known.join(", ")}`);
  const meta: PartMeta = {};
  for (const k of ["partNumber", "description", "vendor"] as const) {
    const v: unknown = o[k];
    if (v === undefined) continue;
    if (typeof v !== "string" && typeof v !== "number") throw new Error(`${what}: ${k} must be a string`);
    meta[k] = String(v);
  }
  if (o.standard !== undefined) meta.standard = !!o.standard;
  const m: unknown = o.material;
  if (m !== undefined) {
    if (typeof m === "string") {
      const found = MATERIALS[m.toLowerCase()];
      if (!found) throw new Error(`${what}: unknown material "${m}"; use one of ${Object.keys(MATERIALS).join(", ")} or { name, density }`);
      meta.material = found;
    } else if (m && typeof m === "object" && ((m as Material).density === undefined || (typeof (m as Material).density === "number" && (m as Material).density! > 0))) meta.material = { ...(m as Material) };
    else throw new Error(`${what}: material must be a name or { name, density } with density in g/cm³`);
  }
  return Object.freeze(meta);
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

/** What makes two declarations of a param the same one. */
const SPEC_KEYS = ["default", "unit", "min", "max", "step", "options", "label", "description", "shared"] as const;

/**
 * Declare a parameter. The value in code is the **default**; the UI and agents can override it
 * per configuration. Returns the effective value, in base units (mm / degrees) for numbers.
 * Declaring the same name again in a part with the same default and options returns the same value
 * (so a helper that declares its params can run more than once); a conflicting one is an error.
 */
export function param(name: string, defaultValue: number, opts?: ParamOptions): number;
export function param<T extends string | number>(name: string, defaultValue: T, opts: ParamOptions & { options: T[] }): T;
export function param(name: string, defaultValue: number | string, opts: ParamOptions = {}): number | string {
  const c = ctx();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) userError(`param name "${name}" must be an identifier (letters, digits, _), so expressions can refer to it`);
  const site = c.frames()[0];
  const unit = opts.unit;
  // the same declaration again (a helper called twice) reads the same value; a different one is an error
  const prev = c.params.find((p) => p.name === name);
  if (prev) {
    const vals = (d: Record<string, unknown>) => SPEC_KEYS.map((k) => JSON.stringify(k === "shared" ? !!d[k] : d[k]));
    const a = vals(prev as unknown as Record<string, unknown>),
      b = vals({ ...opts, default: defaultValue, unit: unit?.symbol });
    const diff = SPEC_KEYS.filter((_, i) => a[i] !== b[i]);
    if (!diff.length) return prev.value;
    userError(
      `param "${name}" is declared twice in ${c.part} with a different ${diff.join(", ")}${prev.source ? ` (first at ${shortLoc(prev.source)})` : ""}. ` +
        `Declaring it again with the same default and options returns the same value, so a helper may declare it on every call; ` +
        `or declare it once and pass the value to the helpers`,
    );
  }
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

/** @internal */
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
  /** Part number, description, vendor (from `part(name, body, options)`). */
  meta?: PartMeta;
  /** Named frames for assembly joints (part coordinates): one per connector, or several for a pattern. */
  connectors?: Record<string, ConnectorFrame[]>;
  params: ParamDecl[];
  problems: Problem[];
  ops: OpRecord[];
  /** ops: time in geometry operations; opCount: operations that ran (not cached); slowest: those taking longest, slowest first. */
  timings: { total: number; ops: number; opCount: number; slowest: OpTiming[]; cacheHits: number; cacheMisses: number };
};

const tools: PartTools = Object.freeze({
  color: Object.freeze({
    auto: (): ColorSpec => ({ kind: "auto" }),
    rgb: (hex: string): ColorSpec => ({ kind: "rgb", hex }),
  }),
});

/** @internal Run a part body in a fresh context. Never throws for script errors: they become problems. */
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
    material: out?.meta.material ?? def.meta?.material,
    meta: def.meta,
    connectors: out?.meta.connectors,
    params: c.params,
    problems: c.problems,
    ops: c.ops,
    timings: { total: performance.now() - t0, ops: c.opTime, opCount: c.opCount, slowest: c.slowest, cacheHits: c.cache.hits, cacheMisses: c.cache.misses },
  };
}

function lastSolidOf(c: PartContext): OpRecord | undefined {
  for (let i = c.ops.length - 1; i >= 0; i--) if (c.ops[i].type !== "sketch") return c.ops[i];
  return undefined;
}

/** @internal */
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
