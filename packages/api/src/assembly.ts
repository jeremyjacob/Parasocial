// assembly(): joints between parts that are modeled in place. The modeled layout is the home
// pose (every joint at 0); people drag the free joints in the viewport, within the limits here.
import type { ConnectorRef, PartDef } from "./part";
import { toFrame, type ConnectorFrame, type FrameSpec } from "./connector";

export type JointType = "fastened" | "revolute" | "slider" | "cylindrical" | "planar" | "ball";

/** Travel of one joint variable: degrees for angles, mm for lengths, relative to the modeled pose (0). */
export type Range = {
  min?: number;
  max?: number;
  /** Where the joint starts until someone drags it (default 0, the modeled pose). */
  value?: number;
};

export type JointOpts = {
  /** Stable name (dragged positions are saved under it). Default: the two part ids. */
  name?: string;
  /** The two parts overlap on purpose (press fit, modeled threads): don't flag it as a collision. */
  overlap?: boolean;
};

/**
 * Where a joint sits: a connector of either part (`lid.at("hinge")`), or a frame given here, in
 * the modeled (home) coordinates: `{ origin: [0, 25, 30], axis: "X" }` or a plane.
 */
export type JointAt = ConnectorRef | FrameSpec;

export type AssemblyTools = {
  /** These parts never move. Without it, each connected group keeps its first part still. */
  fix(...parts: PartDef[]): void;
  /** Rigidly joined. */
  fastened(a: PartDef, b: PartDef, opts?: JointOpts): void;
  /** `b` turns about the joint's z axis relative to `a` (degrees). */
  revolute(a: PartDef, b: PartDef, at: JointAt, opts?: Range & JointOpts): void;
  /** `b` slides along the joint's z axis relative to `a` (mm). */
  slider(a: PartDef, b: PartDef, at: JointAt, opts?: Range & JointOpts): void;
  /** Turns about and slides along the joint's z axis. */
  cylindrical(a: PartDef, b: PartDef, at: JointAt, opts?: JointOpts & { angle?: Range; travel?: Range }): void;
  /** Slides in the joint's xy plane and turns about its z axis. */
  planar(a: PartDef, b: PartDef, at: JointAt, opts?: JointOpts & { x?: Range; y?: Range; angle?: Range }): void;
  /** Turns freely about the joint's origin. */
  ball(a: PartDef, b: PartDef, at: JointAt, opts?: JointOpts): void;
};

export type AssemblyBody = (tools: AssemblyTools) => void;

export type AssemblyDef = {
  readonly __assembly: true;
  readonly name: string;
  readonly body: AssemblyBody;
};

/**
 * Declare an assembly: how a document's parts move against each other. Export it from a studio,
 * `export default assembly("Box", ({ revolute }) => revolute(body, lid, lid.at("hinge"), { min: 0, max: 110 }))`.
 * Parts stay where they're modeled (every joint at 0); in the viewport people drag the parts
 * that are free to move, and overlapping parts show red.
 */
export function assembly(name: string, body: AssemblyBody): AssemblyDef {
  if (typeof name !== "string" || !name.trim()) throw new Error('assembly(name, body): name must be a non-empty string, e.g. assembly("Hinge", ({ revolute }) => ...)');
  if (typeof body !== "function") throw new Error("assembly(name, body): body must be a function that declares joints");
  return Object.freeze({ __assembly: true as const, name, body });
}

// ---------- evaluation (runtime) ----------

/** @internal A joint as declared: frames are resolved later, once the parts have regenerated. */
export type JointDecl = {
  type: JointType;
  a: PartDef;
  b: PartDef;
  at: { connector: ConnectorRef } | { frame: ConnectorFrame };
  limits: (Range | null)[];
  value: number[];
  name?: string;
  overlap: boolean;
  /** Stack at the call, for mapping problems to source. */
  stack: string;
};

/** @internal */
export type AssemblyDecl = { fixed: PartDef[]; joints: JointDecl[] };

const isPart = (v: unknown): v is PartDef => !!v && typeof v === "object" && (v as any).__part === true;
const isConnector = (v: unknown): v is ConnectorRef => !!v && typeof v === "object" && (v as any).__connector === true;

/** @internal Run an assembly body and collect its joints. Throws (with the call's stack) on misuse. */
export function declareAssembly(def: AssemblyDef): AssemblyDecl {
  const out: AssemblyDecl = { fixed: [], joints: [] };
  const where = (type: string, a: unknown, b: unknown) => {
    if (!isPart(a) || !isPart(b)) throw new Error(`${type}(a, b, ...): a and b must be parts (import them from their studios)`);
    if (a === b) throw new Error(`${type}(a, b, ...): a part can't be jointed to itself (${a.name})`);
  };
  const place = (type: string, at: unknown): JointDecl["at"] => {
    if (isConnector(at)) return { connector: at };
    try {
      return { frame: toFrame(at as FrameSpec, type) };
    } catch (e) {
      throw new Error(`${type}(a, b, at): at must be a connector (lid.at("hinge")) or { origin: [x, y, z], axis: "X" }`);
    }
  };
  const range = (type: string, r: Range | undefined): Range | null => {
    if (r === undefined || r === null) return null;
    if (typeof r !== "object") throw new Error(`${type}: a range is { min?, max?, value? }`);
    for (const k of ["min", "max", "value"] as const) if (r[k] !== undefined && !Number.isFinite(r[k])) throw new Error(`${type}: ${k} must be a number`);
    if (r.min !== undefined && r.max !== undefined && r.min > r.max) throw new Error(`${type}: min ${r.min} is above max ${r.max}`);
    return r;
  };
  const add = (type: JointType, a: PartDef, b: PartDef, at: JointDecl["at"], ranges: (Range | undefined)[], opts: JointOpts | undefined) => {
    const limits = ranges.map((r) => range(type, r));
    if (opts?.name !== undefined && (typeof opts.name !== "string" || !opts.name.trim())) throw new Error(`${type}: name must be a non-empty string`);
    out.joints.push({
      type,
      a,
      b,
      at,
      limits,
      value: limits.map((r) => r?.value ?? 0),
      name: opts?.name,
      overlap: !!opts?.overlap,
      stack: new Error().stack ?? "",
    });
  };
  const tools: AssemblyTools = Object.freeze({
    fix: (...parts: PartDef[]) => {
      for (const p of parts) if (!isPart(p)) throw new Error("fix(...parts): pass parts imported from their studios");
      out.fixed.push(...parts);
    },
    fastened: (a: PartDef, b: PartDef, opts?: JointOpts) => {
      where("fastened", a, b);
      add("fastened", a, b, { frame: { origin: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] } }, [], opts);
    },
    revolute: (a: PartDef, b: PartDef, at: JointAt, opts?: Range & JointOpts) => {
      where("revolute", a, b);
      add("revolute", a, b, place("revolute", at), [opts], opts);
    },
    slider: (a: PartDef, b: PartDef, at: JointAt, opts?: Range & JointOpts) => {
      where("slider", a, b);
      add("slider", a, b, place("slider", at), [opts], opts);
    },
    cylindrical: (a: PartDef, b: PartDef, at: JointAt, opts?: JointOpts & { angle?: Range; travel?: Range }) => {
      where("cylindrical", a, b);
      add("cylindrical", a, b, place("cylindrical", at), [opts?.angle, opts?.travel], opts);
    },
    planar: (a: PartDef, b: PartDef, at: JointAt, opts?: JointOpts & { x?: Range; y?: Range; angle?: Range }) => {
      where("planar", a, b);
      add("planar", a, b, place("planar", at), [opts?.x, opts?.y, opts?.angle], opts);
    },
    ball: (a: PartDef, b: PartDef, at: JointAt, opts?: JointOpts) => {
      where("ball", a, b);
      add("ball", a, b, place("ball", at), [undefined, undefined, undefined], opts);
    },
  });
  def.body(tools);
  return out;
}
