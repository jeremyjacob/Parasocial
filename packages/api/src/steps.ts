// buildSteps(): how an assembly is put together, step by step. A build script lives in builds/
// (its own file, never the assembly's studio) and names the assembly it builds. Each step brings
// in some of the assembly's copies and says how they go in: from where, along which axis, turning
// as they go. The workspace's Build view plays the steps.
/**
 * @module steps — build steps: the order an assembly goes together in, and how each part goes in.
 *
 * A build script lives in `builds/<name>.ts` (never in the assembly's studio) and exports
 * `export default buildSteps(mechanism, ({ step, copy, sub }) => { ... })`, where `mechanism` is the
 * assembly imported from its studio (`import mechanism from "../studios/mechanism"`). Each
 * `step(title, parts, opts)` brings in parts, in order; the Build view (the viewport's build button,
 * A) plays them, one step at a time.
 *
 * Which parts: a part (`lid`) is every copy of it not brought in by an earlier step (a set of
 * screws in one go; the assembly's own copies, or its subassemblies' when it has none of its own); `copy(wheel, "fl")` is the copy inserted with that name (`copy(wheel)` the one
 * named directly); `sub(axle, "front")` is a whole inserted subassembly, moving as one, and
 * `sub(axle, "front").part(wheel, "left")` one of its copies. Copies no step names come in last.
 *
 * How they go in (assembly coordinates, mm and degrees; default: lowered in from above):
 * `from: [0, 0, 40]` starts 40 mm above its place and moves straight in; `from: [[30, 0, 40], [0, 0, 40]]`
 * follows waypoints (over, then down) and ends in place. `along: "X" | [x, y, z] | part.at("rail")`
 * slides in along an axis (a connector's z axis, on each copy for a connector of the moving part),
 * starting `distance` mm out along it (negative: from the other side; default from the part's size).
 * `turn: 720` spins it about that axis as it goes (screws, threaded caps, bayonets).
 * `stagger: 0.2` brings a step's copies in one after another (seconds apart); `duration` is seconds
 * per copy (default 1.2). `description` says more in the step's card.
 *
 * Built on its own first: a step bringing in a subassembly takes `build`, the steps that put the
 * subassembly together before it's mounted: its own build script (`import axleSteps from "./axle"`,
 * `builds/axle.ts`) or a body like buildSteps' (`({ step }) => { ... }`). Those steps play first, the
 * subassembly shown on its own in its own coordinates (their `from`/`along` are too); then the step
 * mounts it, moving as one. Several copies of one subassembly in the step (`[sub(axle, "front"),
 * sub(axle, "rear")]`) are built once and mounted together.
 * @example
 * import { buildSteps } from "parasocial";
 * import mechanism from "../studios/mechanism";
 * import body, { lid, drawer } from "../studios/box";
 * export default buildSteps(mechanism, ({ step }) => {
 *   step("Set down the body", body);
 *   step("Slide in the drawer", drawer, { along: drawer.at("rail"), distance: 45 });
 *   step("Fit the lid", lid, { from: [0, 30, 40], description: "Hook the hinge on first, then lower it" });
 * });
 * @example
 * import { buildSteps } from "parasocial";
 * import mechanism from "../studios/mechanism";
 * import axle from "../studios/axle";
 * import base, { wheel } from "../studios/parts";
 * export default buildSteps(mechanism, ({ step, sub }) => {
 *   step("Set down the base", base);
 *   step("Mount the axle", sub(axle, "front"), {
 *     from: [0, 0, 40],
 *     build: ({ step }) => {
 *       step("Set down the axle beam", base);
 *       step("Slide on the wheels", wheel, { along: "X", stagger: 0.2 });
 *     },
 *   });
 * });
 */
import type { Vec3 } from "@parasocial/kernel";
import { axisVec, type AxisLike } from "./plane";
import { instance, subAssembly, type AssemblyDef, type Instance, type SubAssembly } from "./assembly";
import type { ConnectorRef, PartDef } from "./part";

/** What a step brings in: every remaining copy of a part, one copy, or a whole subassembly. */
export type StepTarget = PartDef | Instance | SubAssembly;

/** How a step's parts go in. Directions and offsets are in the assembly's coordinates. */
export type StepMotion = {
  /** Where it starts, from its place (mm): one offset, or waypoints it passes through before ending in place. */
  from?: Vec3 | readonly Vec3[];
  /** Slide in along this axis: "X", "Y", "Z", a vector, or a connector (its z axis; per copy when the connector is on the moving part). */
  along?: AxisLike | ConnectorRef;
  /** How far out along `along` it starts (mm; negative: the other side). Default: from its size. */
  distance?: number;
  /** Degrees it turns about the insertion axis on the way in (screwing it in). */
  turn?: number;
};

export type StepOpts = StepMotion & {
  /** A sentence saying more, shown in the step's card. */
  description?: string;
  /**
   * The subassembly the step brings in is built on its own first, by these steps: its build script
   * (`builds/axle.ts`, imported) or a body like buildSteps'. Then the step mounts it.
   */
  build?: BuildStepsDef | BuildStepsBody;
  /** Seconds between the starts of the step's copies (default 0: together). */
  stagger?: number;
  /** Seconds each copy takes to go in (default 1.2). */
  duration?: number;
};

export type BuildStepsTools = {
  /**
   * The next step: a short imperative title ("Press in the bearings"), what it brings in (a part,
   * a copy, a subassembly, or an array of them) and how they go in.
   */
  step(title: string, parts: StepTarget | readonly StepTarget[], opts?: StepOpts): void;
  /** The copy of `part` inserted as `name` (`insert(part, { name })`); without a name, the copy the assembly names directly. */
  copy(part: PartDef, name?: string): Instance;
  /** An inserted subassembly (`insert(assembly, { name })`): all of it at once, or `.part(p, name?)` for one of its copies. */
  sub(assembly: AssemblyDef, name?: string): SubAssembly;
};

export type BuildStepsBody = (tools: BuildStepsTools) => void;

export type BuildStepsDef = {
  readonly __buildSteps: true;
  readonly assembly: AssemblyDef;
  readonly body: BuildStepsBody;
  readonly meta?: BuildStepsOptions;
};

/** Optional third argument of `buildSteps()`. */
export type BuildStepsOptions = {
  /** What these steps are, when an assembly has several build scripts ("Field repair"). Default: the assembly's name. */
  name?: string;
  /** One line saying more. */
  description?: string;
};

/**
 * Declare how an assembly goes together. Export it from a build script, `builds/<name>.ts`:
 * `export default buildSteps(mechanism, ({ step }) => { step("Set down the base", base); step("Add the lid", lid, { from: [0, 0, 30] }); })`.
 * Steps run in order; each brings in parts and says how they go in (see the steps topic).
 */
export function buildSteps(assembly: AssemblyDef, body: BuildStepsBody, options?: BuildStepsOptions): BuildStepsDef {
  if (!assembly || typeof assembly !== "object" || (assembly as any).__assembly !== true) throw new Error('buildSteps(assembly, body): pass the assembly imported from its studio, e.g. import mechanism from "../studios/mechanism"');
  if (typeof body !== "function") throw new Error("buildSteps(assembly, body): body must be a function that declares steps, e.g. ({ step }) => step(\"Set down the base\", base)");
  let meta: BuildStepsOptions | undefined;
  if (options !== undefined) {
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error('buildSteps(assembly, body, options): options must be an object, e.g. { name: "Field repair" }');
    for (const k of Object.keys(options)) if (k !== "name" && k !== "description") throw new Error(`buildSteps(assembly, body, options): unknown option "${k}"; use name, description`);
    for (const k of ["name", "description"] as const) if (options[k] !== undefined && typeof options[k] !== "string") throw new Error(`buildSteps(assembly, body, options): ${k} must be a string`);
    meta = Object.freeze({ ...options });
  }
  return Object.freeze({ __buildSteps: true as const, assembly, body, ...(meta && { meta }) });
}

// ---------- evaluation (runtime) ----------

/** @internal A step as declared; the runtime resolves its targets to the assembly's copies. */
export type StepDecl = {
  title: string;
  description?: string;
  targets: StepTarget[];
  from?: Vec3[];
  along?: { axis: Vec3 } | { connector: ConnectorRef };
  distance?: number;
  turn?: number;
  stagger?: number;
  duration?: number;
  /** Built on its own first, by these steps (a body is wrapped with the subassembly's assembly). */
  build?: BuildStepsDef;
  stack: string;
};

const isPart = (v: unknown): v is PartDef => !!v && typeof v === "object" && (v as any).__part === true;
const isAssembly = (v: unknown): v is AssemblyDef => !!v && typeof v === "object" && (v as any).__assembly === true;
const isTarget = (v: unknown): v is StepTarget => isPart(v) || (!!v && typeof v === "object" && ((v as any).__instance === true || (v as any).__subassembly === true));
const isBuildStepsDef = (v: unknown): v is BuildStepsDef => !!v && typeof v === "object" && (v as any).__buildSteps === true;
const isConnector = (v: unknown): v is ConnectorRef => !!v && typeof v === "object" && (v as any).__connector === true;
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x));
const checkName = (what: string, name: unknown) => {
  if (name === undefined) return;
  if (typeof name !== "string" || !name.trim() || /[/@]/.test(name)) throw new Error(`${what}: name must be a non-empty string without "/" or "@"`);
};

/** @internal Run a build script's body and collect its steps. Throws (with the call's stack) on misuse. */
export function declareBuildSteps(def: BuildStepsDef): StepDecl[] {
  const out: StepDecl[] = [];
  const known = ["description", "stagger", "duration", "from", "along", "distance", "turn", "build"];
  const tools: BuildStepsTools = {
    step(title, parts, opts = {}) {
      const stack = new Error().stack ?? "";
      if (typeof title !== "string" || !title.trim()) throw new Error('step(title, parts, opts?): title must be a non-empty string, e.g. step("Press in the bearings", bearing)');
      const what = `step("${title}")`;
      const list = (Array.isArray(parts) ? parts : [parts]) as unknown[];
      if (!list.length) throw new Error(`${what}: name at least one part, copy or subassembly`);
      for (const p of list) if (!isTarget(p)) throw new Error(`${what}: parts must be parts imported from their studios, copy(part, name) or sub(assembly, name) (or an array of them)`);
      if (!opts || typeof opts !== "object" || Array.isArray(opts)) throw new Error(`${what}: opts must be an object, e.g. { from: [0, 0, 30] }`);
      for (const k of Object.keys(opts)) if (!known.includes(k)) throw new Error(`${what}: unknown option "${k}"; use ${known.join(", ")}`);
      const d: StepDecl = { title: title.trim(), targets: list as StepTarget[], stack };
      if (opts.description !== undefined) {
        if (typeof opts.description !== "string") throw new Error(`${what}: description must be a string`);
        if (opts.description.trim()) d.description = opts.description.trim();
      }
      for (const k of ["stagger", "duration", "distance", "turn"] as const) {
        const v = opts[k];
        if (v === undefined) continue;
        if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${what}: ${k} must be a number`);
        if ((k === "stagger" && v < 0) || (k === "duration" && v <= 0)) throw new Error(`${what}: ${k} must be ${k === "stagger" ? "0 or more" : "more than 0"} (seconds)`);
        d[k] = v;
      }
      if (opts.from !== undefined) {
        const f = opts.from as unknown;
        if (isVec3(f)) d.from = [[...f] as Vec3];
        else if (Array.isArray(f) && f.length && f.every(isVec3)) d.from = f.map((v) => [...v] as Vec3);
        else throw new Error(`${what}: from must be an offset [x, y, z] (mm from its place) or waypoints [[x, y, z], ...]`);
      }
      if (opts.along !== undefined) {
        if (isConnector(opts.along)) d.along = { connector: opts.along };
        else {
          try {
            d.along = { axis: axisVec(opts.along as AxisLike, `${what}: along`) };
          } catch {
            throw new Error(`${what}: along must be "X", "Y", "Z", a direction [x, y, z] or a connector (part.at("rail"))`);
          }
        }
      }
      if (d.from && d.along) throw new Error(`${what}: give from (where it starts) or along (the axis it slides in on), not both`);
      if (d.distance !== undefined && !d.along) throw new Error(`${what}: distance goes with along (how far out along that axis it starts)`);
      if (opts.build !== undefined) {
        // one subassembly (or copies of one), built on its own first
        const subs = list as SubAssembly[];
        const of = subs[0] && (subs[0] as any).__subassembly === true ? subs[0].of : undefined;
        if (!of || !subs.every((t) => (t as any).__subassembly === true && t.of === of)) throw new Error(`${what}: build goes with a subassembly, sub(assembly, name) (or copies of one assembly), not parts or copies`);
        const b = opts.build as unknown;
        if (isBuildStepsDef(b)) {
          if (b.assembly !== of) throw new Error(`${what}: build: those steps build "${b.assembly.name}", not "${of.name}"`);
          d.build = b;
        } else if (typeof b === "function") d.build = buildSteps(of, b as BuildStepsBody);
        else throw new Error(`${what}: build must be the subassembly's build steps (imported from its build script) or a body, ({ step }) => { ... }`);
      }
      out.push(d);
    },
    copy(part, name) {
      if (!isPart(part)) throw new Error("copy(part, name?): pass a part imported from its studio");
      checkName("copy", name);
      return instance(part, name);
    },
    sub(asm, name) {
      if (!isAssembly(asm)) throw new Error("sub(assembly, name?): pass an assembly imported from its studio");
      checkName("sub", name);
      return subAssembly(asm, name);
    },
  };
  def.body(tools);
  return out;
}
