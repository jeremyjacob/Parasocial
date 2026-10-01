// assembly(): joints between parts that are modeled in place. The assembly holds its own copies
// (instances) of the parts it names; the parts themselves stay where they are in their studios.
// A part named directly is one copy where it's modeled; insert() adds more copies (and copies of
// other assemblies), placed by hand or by joining connector to connector. The home pose is every
// joint at 0; people drag the free joints of the instances in the viewport, within the limits here.
/**
 * @module assembly — how parts move against each other.
 *
 * Instead of parts, a studio can export an assembly:
 * `export default assembly("Box", ({ revolute, slider, cylindrical, planar, ball, fastened, fix, insert }) => revolute(body, lid, body.at("hinge"), { min: 0, max: 110 }))`,
 * where `body.at("hinge")` is a connector declared in that part's body with
 * `.connector("hinge", face | edge | { origin, axis })`. A studio exports parts or assemblies, never
 * both, so an assembly imports its parts from other studios.
 *
 * Instances: an assembly holds its own copies of the parts it names, ids like `mechanism/box:lid`
 * (assembly id / part id); the source parts stay put. describe/query/measure accept instance ids;
 * notes pinned in an assembly target instances. A part named directly is one copy where it's
 * modeled; for more, `const w = insert(wheel, { name: "fl" })` (id `mechanism/cart:wheel@fl`; a name
 * is required from the second copy on), then join connector to connector,
 * `revolute(chassis.at("axle", 0), w.at("hub"))` (puts w's connector on the chassis's; 0 is where
 * they meet; `{ flip: true }` faces it the other way), or `insert(part, { name, place: { translate, rotate: { axis, angle } } })`.
 * Loops make patterns. A connector on several faces/edges (`.connector("bolt", holes)`) or an array
 * of frames has one frame each: `part.at("bolt", i)`, 0-based, ordered by x, then y, then z. The
 * assembly script can't see geometry, so share counts (a constant in lib/) between part and assembly.
 * `insert(otherAssembly, { name })` adds a subassembly with its joints (parts `mechanism/corner@left/cart:wheel`);
 * reach its parts with `sub.part(wheel).at("hub")`; its `fix()` only holds its parts to each other.
 *
 * Joints: every joint is 0 where the parts are modeled; limits are degrees or mm from there.
 * Positive revolute angles follow the right-hand rule about the joint axis and positive slides go
 * along it, so flip the axis to make "open" positive. In a closed loop the first joint declared
 * drives it. People drag free instances in the viewport; overlapping instances show red (pass
 * `{ overlap: true }` on a joint for intended overlaps like press fits). The workspace shows one
 * studio at a time.
 */
import type { Vec3 } from "@parasocial/kernel";
import { connectorRef, type ConnectorRef, type PartDef } from "./part";
import { toFrame, type ConnectorFrame, type FrameSpec } from "./connector";
import { axisVec, vec, type AxisLike } from "./plane";

export type JointType = "fastened" | "revolute" | "slider" | "cylindrical" | "planar" | "ball";

/** Travel of one joint variable: degrees for angles, mm for lengths, relative to the home pose (0). */
export type Range = {
  min?: number;
  max?: number;
  /** Where the joint starts until someone drags it (default 0, the home pose). */
  value?: number;
};

export type JointOpts = {
  /** Stable name (dragged positions are saved under it). Default: the two part ids. */
  name?: string;
  /** The two parts overlap on purpose (press fit, modeled threads): don't flag it as a collision. */
  overlap?: boolean;
};

/** Options of a connector-to-connector joint. */
export type MateOpts = {
  /** Face the other way: `b` turns half a turn about its connector's x axis, so the z axes oppose. */
  flip?: boolean;
};

/**
 * Where a joint sits: a connector of either part (`lid.at("hinge")`), or a frame given here, in
 * the modeled (home) coordinates: `{ origin: [0, 25, 30], axis: "X" }` or a plane.
 */
export type JointAt = ConnectorRef | FrameSpec;

/** Where a copy goes, from where its part is modeled: turned first (degrees, about `origin`, default the origin), then moved. */
export type Placement = { translate?: Vec3; rotate?: { axis: AxisLike; angle: number; origin?: Vec3 } };

export type InsertOpts = {
  /**
   * Tells copies of the same part (or assembly) apart: required from the second copy on. The copy's
   * id is `<assembly>/<part>@<name>`, and dragged positions and notes stay with the name.
   */
  name?: string;
  /** Where it goes (default: where it's modeled, or where a connector-to-connector joint puts it). */
  place?: Placement;
};

/** A copy of a part in an assembly: from `insert(part)`, or a part inside an inserted assembly. Use it in joints like a part. */
export type Instance = {
  readonly __instance: true;
  readonly of: PartDef;
  readonly name?: string;
  /** The inserted assembly it belongs to (none: this assembly's own copy). */
  readonly within?: SubAssembly;
  /** A connector of this copy: `revolute(chassis.at("axle", i), wheel.at("hub"))`. */
  at(connector: string, index?: number): ConnectorRef;
};

/** A copy of another assembly (from `insert(assembly)`): its parts keep their joints; join one of them to place it. */
export type SubAssembly = {
  readonly __subassembly: true;
  readonly of: AssemblyDef;
  readonly name?: string;
  readonly within?: SubAssembly;
  /** Its copy of a part (inserted under `name`, else the part itself): `corner.part(hub).at("axle")`. */
  part(def: PartDef, name?: string): Instance;
  /** An assembly it inserts in turn. */
  assembly(def: AssemblyDef, name?: string): SubAssembly;
};

/** A part (its one copy where it's modeled) or a copy from `insert`. */
export type Body = PartDef | Instance;

export type AssemblyTools = {
  /**
   * Another copy of a part, or a copy of another assembly (a subassembly, its joints included):
   * `const w = insert(wheel, { name: "front left" })`. Join it connector to connector to put it in
   * place, `revolute(chassis.at("axle", 0), w.at("hub"))`, or `place` it. Loops make patterns.
   */
  insert(part: PartDef, opts?: InsertOpts): Instance;
  insert(assembly: AssemblyDef, opts?: InsertOpts): SubAssembly;
  /** These never move (a subassembly: all its parts). Without it, each connected group keeps its first part still. */
  fix(...parts: (Body | SubAssembly)[]): void;
  /** Rigidly joined: where they are, or connector to connector. */
  fastened(a: Body, b: Body, opts?: JointOpts): void;
  fastened(a: ConnectorRef, b: ConnectorRef, opts?: JointOpts & MateOpts): void;
  /**
   * `b` turns about the joint's z axis relative to `a` (degrees). Positive is counterclockwise
   * looking back down z (right-hand rule: thumb along z). To make "open" or "raise" positive,
   * point the axis the other way (`axis: [-1, 0, 0]` instead of `"X"`). Connector to connector,
   * `revolute(a.at("pin"), b.at("hole"))`, puts b's connector on a's (0 is where they meet).
   */
  revolute(a: Body, b: Body, at: JointAt, opts?: Range & JointOpts): void;
  revolute(a: ConnectorRef, b: ConnectorRef, opts?: Range & JointOpts & MateOpts): void;
  /** `b` slides along the joint's z axis relative to `a` (mm); positive moves it toward +z. */
  slider(a: Body, b: Body, at: JointAt, opts?: Range & JointOpts): void;
  slider(a: ConnectorRef, b: ConnectorRef, opts?: Range & JointOpts & MateOpts): void;
  /** Turns about and slides along the joint's z axis. */
  cylindrical(a: Body, b: Body, at: JointAt, opts?: JointOpts & { angle?: Range; travel?: Range }): void;
  cylindrical(a: ConnectorRef, b: ConnectorRef, opts?: JointOpts & MateOpts & { angle?: Range; travel?: Range }): void;
  /** Slides in the joint's xy plane and turns about its z axis. */
  planar(a: Body, b: Body, at: JointAt, opts?: JointOpts & { x?: Range; y?: Range; angle?: Range }): void;
  planar(a: ConnectorRef, b: ConnectorRef, opts?: JointOpts & MateOpts & { x?: Range; y?: Range; angle?: Range }): void;
  /** Turns freely about the joint's origin. */
  ball(a: Body, b: Body, at: JointAt, opts?: JointOpts): void;
  ball(a: ConnectorRef, b: ConnectorRef, opts?: JointOpts & MateOpts): void;
};

export type AssemblyBody = (tools: AssemblyTools) => void;

export type AssemblyDef = {
  readonly __assembly: true;
  readonly name: string;
  readonly body: AssemblyBody;
};

/**
 * Declare an assembly: how a document's parts move against each other. Export it from its own
 * studio (a studio exports parts or assemblies, not both), `export default assembly("Box", ({ revolute }) => revolute(body, lid, lid.at("hinge"), { min: 0, max: 110 }))`.
 * The assembly studio shows a copy (instance) of each part it names, id `<assembly>/<part>`
 * (e.g. `mechanism/box:lid`); the source parts stay put in their studios. More copies come from
 * `insert` (`<assembly>/<part>@<name>`), including copies of other assemblies (their parts are
 * `<assembly>/<sub>@<name>/<part>`). Every joint is 0 where the parts are modeled, or where two
 * connectors meet; in the viewport people drag the ones that are free to move, and overlapping
 * instances show red.
 */
export function assembly(name: string, body: AssemblyBody): AssemblyDef {
  if (typeof name !== "string" || !name.trim()) throw new Error('assembly(name, body): name must be a non-empty string, e.g. assembly("Hinge", ({ revolute }) => ...)');
  if (typeof body !== "function") throw new Error("assembly(name, body): body must be a function that declares joints");
  return Object.freeze({ __assembly: true as const, name, body });
}

// ---------- evaluation (runtime) ----------

/** @internal A rigid transform: rotation (row-major 3×3) and translation. */
export type PlacePose = { r: number[]; t: Vec3 };

/** @internal A joint as declared: frames are resolved later, once the parts have regenerated. */
export type JointDecl = {
  type: JointType;
  a: Body;
  b: Body;
  at: { connector: ConnectorRef } | { frame: ConnectorFrame } | { mate: [ConnectorRef, ConnectorRef]; flip: boolean };
  limits: (Range | null)[];
  value: number[];
  name?: string;
  overlap: boolean;
  /** Stack at the call, for mapping problems to source. */
  stack: string;
};

/** @internal A copy made with insert(). */
export type InsertDecl = { handle: Instance | SubAssembly; place?: PlacePose; stack: string };

/** @internal `order`: inserts and the parts named, in the order the script makes or first names them. */
export type AssemblyDecl = { fixed: (Body | SubAssembly)[]; joints: JointDecl[]; inserts: InsertDecl[]; order: ({ insert: InsertDecl } | { body: Body })[] };

const isPart = (v: unknown): v is PartDef => !!v && typeof v === "object" && (v as any).__part === true;
const isAssembly = (v: unknown): v is AssemblyDef => !!v && typeof v === "object" && (v as any).__assembly === true;
const isInstance = (v: unknown): v is Instance => !!v && typeof v === "object" && (v as any).__instance === true;
const isSub = (v: unknown): v is SubAssembly => !!v && typeof v === "object" && (v as any).__subassembly === true;
const isConnector = (v: unknown): v is ConnectorRef => !!v && typeof v === "object" && (v as any).__connector === true;
const isBody = (v: unknown): v is Body => isPart(v) || isInstance(v);
/** @internal A connector's body: the copy it's on, else its part. */
export const bodyOf = (c: ConnectorRef): Body => c.instance ?? c.part;

const checkName = (what: string, name: unknown) => {
  if (name === undefined) return;
  if (typeof name !== "string" || !name.trim() || /[/@]/.test(name)) throw new Error(`${what}: name must be a non-empty string without "/" or "@"`);
};

function instance(of: PartDef, name?: string, within?: SubAssembly): Instance {
  const label = name ? `${of.name} "${name}"` : of.name;
  const inst: Instance = Object.freeze({
    __instance: true as const,
    of,
    ...(name !== undefined && { name }),
    ...(within && { within }),
    at: (connector: string, index?: number) => connectorRef(of, label, connector, index, inst),
  });
  return inst;
}

function subAssembly(of: AssemblyDef, name?: string, within?: SubAssembly): SubAssembly {
  const sub: SubAssembly = Object.freeze({
    __subassembly: true as const,
    of,
    ...(name !== undefined && { name }),
    ...(within && { within }),
    part: (def: PartDef, n?: string) => {
      if (!isPart(def)) throw new Error(`${of.name}.part(part, name?): pass a part imported from its studio`);
      checkName(`${of.name}.part`, n);
      return instance(def, n, sub);
    },
    assembly: (def: AssemblyDef, n?: string) => {
      if (!isAssembly(def)) throw new Error(`${of.name}.assembly(assembly, name?): pass an assembly imported from its studio`);
      checkName(`${of.name}.assembly`, n);
      return subAssembly(def, n, sub);
    },
  });
  return sub;
}

function placement(p: Placement): PlacePose {
  if (!p || typeof p !== "object") throw new Error("insert: place is { translate?: [x, y, z], rotate?: { axis, angle, origin? } }");
  const vec3 = (v: unknown, what: string): Vec3 => {
    if (!Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite)) throw new Error(`insert: place.${what} must be [x, y, z]`);
    return v as Vec3;
  };
  let r = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let t: Vec3 = p.translate === undefined ? [0, 0, 0] : vec3(p.translate, "translate");
  if (p.rotate !== undefined) {
    const { axis, angle, origin } = p.rotate;
    if (!Number.isFinite(angle)) throw new Error("insert: place.rotate.angle must be a number (degrees)");
    const [x, y, z] = axisVec(axis);
    const a = (angle * Math.PI) / 180,
      c = Math.cos(a),
      s = Math.sin(a),
      k = 1 - c;
    r = [c + x * x * k, x * y * k - z * s, x * z * k + y * s, y * x * k + z * s, c + y * y * k, y * z * k - x * s, z * x * k - y * s, z * y * k + x * s, c + z * z * k];
    // about `origin`: p' = R(p - o) + o + translate
    const o = origin === undefined ? ([0, 0, 0] as Vec3) : vec3(origin, "rotate.origin");
    const ro: Vec3 = [r[0] * o[0] + r[1] * o[1] + r[2] * o[2], r[3] * o[0] + r[4] * o[1] + r[5] * o[2], r[6] * o[0] + r[7] * o[1] + r[8] * o[2]];
    t = vec.add(t, vec.add(o, vec.scale(ro, -1)));
  }
  return { r, t };
}

/** @internal Run an assembly body and collect its copies and joints. Throws (with the call's stack) on misuse. */
export function declareAssembly(def: AssemblyDef): AssemblyDecl {
  const out: AssemblyDecl = { fixed: [], joints: [], inserts: [], order: [] };
  const inserted = new Map<unknown, Set<string | undefined>>();
  const where = (type: string, a: unknown, b: unknown) => {
    if (!isBody(a) || !isBody(b)) throw new Error(`${type}(a, b, ...): a and b must be parts (import them from their studios) or copies from insert()`);
    if (a === b) throw new Error(`${type}(a, b, ...): a part can't be jointed to itself (${a.name ?? (a as Instance).of.name})`);
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
  const add = (type: JointType, a: Body, b: Body, at: JointDecl["at"], ranges: (Range | undefined)[], opts: JointOpts | undefined) => {
    const limits = ranges.map((r) => range(type, r));
    if (opts?.name !== undefined && (typeof opts.name !== "string" || !opts.name.trim())) throw new Error(`${type}: name must be a non-empty string`);
    out.order.push({ body: a }, { body: b });
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
  /**
   * The two call forms: (a, b, at, opts) with parts, or (a.at(..), b.at(..), opts) connector to
   * connector. `ranges` picks the joint's ranges out of the options.
   */
  const joint = (type: JointType, x: unknown, y: unknown, z: unknown, w: unknown, ranges: (o: any) => (Range | undefined)[]) => {
    if (isConnector(x) || isConnector(y)) {
      if (!isConnector(x) || !isConnector(y)) throw new Error(`${type}(a, b, ...): connector to connector takes two connectors, ${type}(base.at("pin"), arm.at("hole"))`);
      const a = bodyOf(x),
        b = bodyOf(y);
      if (a === b) throw new Error(`${type}(a, b): both connectors are on the same part`);
      const opts = z as (JointOpts & MateOpts) | undefined;
      add(type, a, b, { mate: [x, y], flip: !!opts?.flip }, ranges(opts), opts);
      return;
    }
    where(type, x, y);
    if (type === "fastened") return add(type, x as Body, y as Body, { frame: { origin: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] } }, [], z as JointOpts | undefined);
    add(type, x as Body, y as Body, place(type, z), ranges(w), w as JointOpts | undefined);
  };
  const tools = Object.freeze({
    insert: (what: PartDef | AssemblyDef, opts?: InsertOpts): any => {
      if (!isPart(what) && !isAssembly(what)) throw new Error("insert(part, { name?, place? }): pass a part or an assembly imported from its studio");
      if (opts !== undefined && (typeof opts !== "object" || opts === null)) throw new Error("insert(part, opts): opts is { name?, place? }");
      checkName("insert", opts?.name);
      const names = inserted.get(what) ?? new Set();
      if (names.has(opts?.name)) throw new Error(opts?.name === undefined ? `insert(${what.name}) again: name each copy, insert(${what.name}, { name: "2" })` : `insert(${what.name}): there's already a copy named "${opts.name}"`);
      names.add(opts?.name);
      inserted.set(what, names);
      const handle = isPart(what) ? instance(what, opts?.name) : subAssembly(what, opts?.name);
      const ins: InsertDecl = { handle, ...(opts?.place !== undefined && { place: placement(opts.place) }), stack: new Error().stack ?? "" };
      out.inserts.push(ins);
      out.order.push({ insert: ins });
      return handle;
    },
    fix: (...parts: (Body | SubAssembly)[]) => {
      for (const p of parts) if (!isBody(p) && !isSub(p)) throw new Error("fix(...parts): pass parts imported from their studios, or copies from insert()");
      out.fixed.push(...parts);
      for (const p of parts) if (!isSub(p)) out.order.push({ body: p });
    },
    fastened: (a: unknown, b: unknown, opts?: unknown) => joint("fastened", a, b, opts, undefined, () => []),
    revolute: (a: unknown, b: unknown, at?: unknown, opts?: unknown) => joint("revolute", a, b, at, opts, (o) => [o]),
    slider: (a: unknown, b: unknown, at?: unknown, opts?: unknown) => joint("slider", a, b, at, opts, (o) => [o]),
    cylindrical: (a: unknown, b: unknown, at?: unknown, opts?: unknown) => joint("cylindrical", a, b, at, opts, (o) => [o?.angle, o?.travel]),
    planar: (a: unknown, b: unknown, at?: unknown, opts?: unknown) => joint("planar", a, b, at, opts, (o) => [o?.x, o?.y, o?.angle]),
    ball: (a: unknown, b: unknown, at?: unknown, opts?: unknown) => joint("ball", a, b, at, opts, () => [undefined, undefined, undefined]),
  }) as AssemblyTools;
  def.body(tools);
  return out;
}
