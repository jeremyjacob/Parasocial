// Solids: finishing, booleans, transforms, patterns, inspection (PLAN §5 v1 surface).
import { fillet as kFillet, booleanMany as kBooleanMany, shell as kShell, draft as kDraft, split as kSplit, thicken as kThicken, planeFace, chamfer as kChamfer, boolean as kBoolean, transform as kTransform, box as kBox, cylinder as kCylinder, compound, massProps as kMass, boundingBox as kBBox, isValid as kValid, identityHistory, faceInfo, type Vec3, type KernelError, type BBox, type EntityKind } from "@parasocial/kernel";
import { entityShape, entityName, faceOf, edgeOf, vertexOf, type OpRecord } from "@parasocial/naming";
import { runOp, userError, warn } from "./op";
import { EntitySet, type OpRef } from "./selection";
import { Plane, axisVec, vec, type AxisLike } from "./plane";
import { sketch } from "./sketch";
import type { Appearance, ColorSpec, Material } from "./types";
import { toFrame, transformFrame, type ConnectorFrame, type FrameSpec } from "./connector";
import { resolveHole, nutTrapTools, freeTag, type HoleSpec, type NutTrapOpts } from "./std/holes";
import { num, optNum, positive, int, vec3 } from "./check";

type EdgesArg = EntitySet | EntitySet[] | string;
type FacesArg = EntitySet | EntitySet[] | string;
type OpOpts = { tag?: string };

/**
 * An immutable solid: every operation returns a new `Solid` (reassign: `body = body.fillet(...)`).
 * Make one with `sketch(...).extrude/revolve/sweep`, `loft`, `box`, `cylinder` or `thicken`. All
 * lengths are mm and angles degrees. Pass `{ tag }` to any operation so its faces get stable names
 * people can point at.
 * @example const body = box(40, 30, 10, { center: "xy", tag: "base" }).fillet("|Z", 4).subtract(cylinder(5, 10, { tag: "bore" }))
 */
export class Solid {
  /** @internal */ readonly record: OpRecord;
  /** @internal */ readonly meta: { color?: ColorSpec; appearance?: Appearance; material?: Material; connectors?: Record<string, ConnectorFrame[]> };

  /** @internal */
  constructor(record: OpRecord, meta: Solid["meta"] = {}) {
    this.record = record;
    this.meta = meta;
    Object.freeze(this);
  }

  /** Stable id of the operation that produced this solid. */
  get id() {
    return this.record.id;
  }

  // ---------- selection ----------
  /**
   * Faces matching `selector` (all when omitted). Selectors: names (`"base.side"`, `"bore"`),
   * extremes (`">Z"`, `"<X"`, `">Z[1]"`), direction (`"|Z"` normal parallel to Z, `"#Z"` normal
   * perpendicular to Z, `"+Z"` facing +Z), type (`"%plane"`, `"%cylinder"`), and `& | - not`.
   * Narrow further with `EntitySet` filters.
   * Or `{ createdBy, where }`: the faces an operation created (see `EntitySet.createdBy`), optionally narrowed
   * by a selector; the selector `"@finUnion"` does the same.
   * @example body.faces(">Z") // the top face(s)
   */
  faces(selector?: string | SelectOpts): EntitySet {
    return select(this.record, "face", selector);
  }
  /**
   * Edges matching `selector` (all when omitted; seam edges are skipped). Name patterns match the
   * faces around an edge: `edges("bore & >Z")` is the bore's top rim. `"|Z"` are straight edges
   * along Z, `"#Z"` straight edges perpendicular to Z, `">Z"` the highest edges (circles included),
   * `"%circle"` circular edges.
   * Or `{ createdBy, where }`: `body.edges({ createdBy: "finUnion" })` is the new edges where the fin met the
   * body (selector `"@finUnion"`): fillet them without filtering by coordinates.
   * @example body.fillet(body.edges("|Z"), 2) // round the vertical edges
   */
  edges(selector?: string | SelectOpts): EntitySet {
    return select(this.record, "edge", selector);
  }
  /** Vertices matching `selector` (all when omitted), e.g. `vertices(">Z")`, or `{ createdBy, where }`. */
  vertices(selector?: string | SelectOpts): EntitySet {
    return select(this.record, "vertex", selector);
  }

  // ---------- finishing ----------
  /**
   * Round `edges` with a constant `radius` (mm). `edges` is a selection (from this solid or an
   * earlier one: matched by stable name), an array of selections, or a selector string evaluated on
   * this solid. New faces get the role `fillet` (`fillet.corner` at vertex blends). Fails with the
   * largest workable radius when it doesn't fit.
   * @example body = body.fillet(body.edges("|Z"), 3, { tag: "corners" })
   * @example body = body.fillet(body.edges(">Z"), 1) // soften the top edges
   */
  fillet(edges: EdgesArg, radius: number, opts: OpOpts = {}): Solid {
    positive(radius, "fillet radius");
    const idx = this.resolve(edges, "edge", "fillet");
    const input = this.record;
    const rec = runOp({
      type: "fillet",
      tag: opts.tag,
      params: { edges: idx, radius },
      inputs: [input],
      build: () => ({
        built: kFillet(input.shape, idx.map((i) => entityShape(input, "edge", i)), radius),
        historyOptions: { generatedFrom: ["edge", "vertex"] },
        roles: ({ history }) => ({ face: history.face.map((o) => (o.some((x) => x.rel === "generated" && x.kind === "edge") ? "fillet" : o.some((x) => x.rel === "generated" && x.kind === "vertex") ? "fillet.corner" : undefined)) }),
      }),
      highlight: () => ({ kind: "edge", names: idx.map((i) => entityName(input, "edge", i).str) }),
      explain: () => explainRadius("fillet radius", radius, input, idx),
    });
    return new Solid(rec, this.meta);
  }

  /**
   * Bevel `edges` (selection or selector string, as in `fillet`) by `distance` mm, symmetric; or
   * unequal with `distance2`, or a distance and an `angle` in degrees. New faces get the role `chamfer`.
   * @example body = body.chamfer(body.edges("<Z"), 0.5) // break the bottom edges
   */
  chamfer(edges: EdgesArg, distance: number, opts: OpOpts & { distance2?: number; angle?: number } = {}): Solid {
    positive(distance, "chamfer distance");
    if (opts.distance2 !== undefined) positive(opts.distance2, "chamfer distance2");
    optNum(opts.angle, "chamfer angle");
    const idx = this.resolve(edges, "edge", "chamfer");
    const input = this.record;
    const rec = runOp({
      type: "chamfer",
      tag: opts.tag,
      params: { edges: idx, distance, distance2: opts.distance2, angle: opts.angle },
      inputs: [input],
      build: () => ({
        built: kChamfer(input.shape, idx.map((i) => entityShape(input, "edge", i)), distance, opts.distance2, opts.angle === undefined ? undefined : (opts.angle * Math.PI) / 180),
        historyOptions: { generatedFrom: ["edge", "vertex"] },
        roles: ({ history }) => ({ face: history.face.map((o) => (o.some((x) => x.rel === "generated") ? "chamfer" : undefined)) }),
      }),
      highlight: () => ({ kind: "edge", names: idx.map((i) => entityName(input, "edge", i).str) }),
      explain: () => explainRadius("chamfer distance", distance, input, idx),
    });
    return new Solid(rec, this.meta);
  }

  // ---------- booleans ----------
  /**
   * Fuse one or more solids into this one; an options object `{ tag }` may come last.
   * @example body.union(boss, rib, { tag: "joined" })
   */
  union(...others: (Solid | OpOpts)[]): Solid {
    return booleanOp("union", this, ...splitOpts(others));
  }
  /**
   * Remove one or more solids from this one (holes, pockets); an options object `{ tag }` may come last.
   * Faces cut by a tool keep the tool's names (tag the tool: `cylinder(3, 20, { tag: "bore" })`).
   * @example plate.subtract(cylinder(3, 20, { at: [10, 10, -5], tag: "bore" }))
   */
  subtract(...others: (Solid | OpOpts)[]): Solid {
    return booleanOp("subtract", this, ...splitOpts(others));
  }
  /** Alias of subtract (CadQuery). */
  cut(...others: (Solid | OpOpts)[]): Solid {
    return this.subtract(...others);
  }
  /**
   * Keep only the volume common to this solid and every other one; an options object `{ tag }` may come last.
   * @example box(20, 20, 20, { center: true }).intersect(cylinder(12, 40, { center: true })) // rounded block
   */
  intersect(...others: (Solid | OpOpts)[]): Solid {
    return booleanOp("intersect", this, ...splitOpts(others));
  }

  // ---------- transforms ----------
  /** Move by `[dx, dy, dz]` mm. Names are kept. */
  translate(v: Vec3, opts: OpOpts = {}): Solid {
    return transformOp(this, "translate", { translate: vec3(v, "translate") }, opts);
  }
  /** Alias of translate. */
  move(v: Vec3, opts: OpOpts = {}): Solid {
    return this.translate(v, opts);
  }
  /** Rotate by `angle` degrees about `axis` (default Z) through `origin` (default world origin). */
  rotate(angle: number, opts: OpOpts & { axis?: AxisLike; origin?: Vec3 } = {}): Solid {
    num(angle, "rotate angle");
    const origin = opts.origin === undefined ? ([0, 0, 0] as Vec3) : vec3(opts.origin, "rotate origin");
    return transformOp(this, "rotate", { rotate: { origin, axis: axisVec(opts.axis ?? "Z", "rotate axis"), angleRad: (angle * Math.PI) / 180 } }, opts);
  }
  /**
   * Mirror across a plane: a `Plane`, or "XY" (z → −z), "XZ" (y → −y), "YZ" (x → −x) through the
   * origin. `union: true` keeps the original and fuses the mirror image to it.
   * @example half.mirror("YZ", { union: true }) // symmetric about x = 0
   */
  mirror(p: Plane | "XY" | "XZ" | "YZ", opts: OpOpts & { union?: boolean } = {}): Solid {
    const pl = typeof p === "string" ? ({ XY: new Plane([0, 0, 0], [0, 0, 1]), XZ: new Plane([0, 0, 0], [0, 1, 0]), YZ: new Plane([0, 0, 0], [1, 0, 0]) } as const)[p] : p;
    const m = transformOp(this, "mirror", { mirror: { origin: pl.origin, normal: pl.normal } }, opts.union ? {} : opts, "mirrored");
    return opts.union ? booleanOp("union", this, [m], { tag: opts.tag }) : m;
  }
  /**
   * `count` copies (including this one) spaced `spacing` mm along `direction`, fused (instance 0 keeps its names; others get `#k`).
   * @example peg.linearPattern("X", 4, 10) // 4 pegs, 10 mm apart
   */
  linearPattern(direction: AxisLike, count: number, spacing: number, opts: OpOpts = {}): Solid {
    const d = axisVec(direction, "linearPattern direction");
    int(count, "linearPattern count", 1);
    num(spacing, "linearPattern spacing");
    return patternOp(this, count, (k) => ({ translate: vec.scale(d, spacing * k) }), opts);
  }
  /**
   * `count` copies (including this one) around `axis` (default Z through `origin`, default the world origin) over `angle` degrees (default 360, evenly spaced; otherwise first and last at the ends).
   * @example hole.circularPattern(6) // 6 holes, 60° apart around Z
   */
  circularPattern(count: number, opts: OpOpts & { axis?: AxisLike; origin?: Vec3; angle?: number } = {}): Solid {
    int(count, "circularPattern count", 1);
    const total = optNum(opts.angle, "circularPattern angle") ?? 360;
    const origin = opts.origin === undefined ? ([0, 0, 0] as Vec3) : vec3(opts.origin, "circularPattern origin");
    const axis = axisVec(opts.axis ?? "Z", "circularPattern axis");
    const step = Math.abs(total - 360) < 1e-9 ? total / count : total / Math.max(1, count - 1);
    return patternOp(this, count, (k) => ({ rotate: { origin, axis, angleRad: (step * k * Math.PI) / 180 } }), opts);
  }

  // ---------- M6: shell, draft, split, holes ----------
  /** Hollow the solid, leaving `openFaces` open, with walls of `thickness` (inward). */
  shell(openFaces: FacesArg, thickness: number, opts: OpOpts = {}): Solid {
    positive(thickness, "shell thickness");
    const idx = this.resolve(openFaces, "face", "shell");
    const input = this.record;
    const rec = runOp({
      type: "shell",
      tag: opts.tag,
      params: { faces: idx, thickness },
      inputs: [input],
      build: () => ({
        built: kShell(input.shape, idx.map((i) => entityShape(input, "face", i)), thickness),
        historyOptions: { generatedFrom: ["face", "edge"] },
        roles: ({ history }) => ({ face: history.face.map((o) => (o.some((x) => x.rel === "generated" && x.kind === "face") ? "inner" : o.some((x) => x.rel === "generated") ? "rim" : undefined)) }),
      }),
      highlight: () => ({ kind: "face", names: idx.map((i) => entityName(input, "face", i).str) }),
    });
    return new Solid(rec, this.meta);
  }

  /** Taper `faces` by `angle` degrees about a neutral plane (default XY), pulling along `pull` (default +Z). */
  draft(faces: FacesArg, angle: number, opts: OpOpts & { pull?: AxisLike; neutral?: Plane } = {}): Solid {
    num(angle, "draft angle");
    const idx = this.resolve(faces, "face", "draft");
    const input = this.record;
    const pull = axisVec(opts.pull ?? "Z", "draft pull");
    const neutral = opts.neutral ?? new Plane([0, 0, 0], [0, 0, 1]);
    const rec = runOp({
      type: "draft",
      tag: opts.tag,
      params: { faces: idx, angle, pull, neutral: neutral.toJSON() },
      inputs: [input],
      build: () => ({ built: kDraft(input.shape, idx.map((i) => entityShape(input, "face", i)), pull, (angle * Math.PI) / 180, neutral.origin, neutral.normal) }),
      highlight: () => ({ kind: "face", names: idx.map((i) => entityName(input, "face", i).str) }),
    });
    return new Solid(rec, this.meta);
  }

  /** Split by a plane or another solid; the result holds every piece. */
  split(tool: Plane | Solid, opts: OpOpts = {}): Solid {
    const input = this.record;
    const isPlane = tool instanceof Plane;
    const inputs = isPlane ? [input] : [input, (tool as Solid).record];
    const rec = runOp({
      type: "split",
      tag: opts.tag,
      params: isPlane ? { plane: (tool as Plane).toJSON() } : {},
      inputs,
      build: () => {
        const bb = kBBox(input.shape);
        const size = 4 * Math.max(1, ...bb.max.map((v, i) => Math.abs(v - bb.min[i])));
        const toolShape = isPlane ? planeFace((tool as Plane).origin, (tool as Plane).normal, size) : (tool as Solid).record.shape;
        return { built: kSplit(input.shape, [toolShape]), historyOptions: { generatedFrom: ["edge"] } };
      },
    });
    return new Solid(rec, this.meta);
  }

  /**
   * Drill holes at `points` (world) along `direction` (default: into the part, −Z).
   * Simple, counterbored ({ counterbore: { diameter, depth } }) or countersunk ({ countersink: { diameter, angle } }).
   * `depth` omitted = through all.
   *
   * Or by standard, with a spec instead of a diameter (see `HoleSpec`):
   * `.hole(pts, { screw: "M3", counterbore: "ISO4762" })`, `{ screw: "M4", fit: "tap", depth: 8 }`,
   * `{ screw: "M5", countersink: "ISO10642" }`, `{ insert: "M3x5.7" }`; `connector: "bolt"` adds a
   * frame at each hole's screw seat for assemblies.
   */
  hole(
    points: Vec3[] | Vec3,
    diameter: number | HoleSpec,
    opts: OpOpts & { depth?: number; direction?: AxisLike; counterbore?: { diameter: number; depth: number }; countersink?: { diameter: number; angle?: number; recess?: number } } = {},
  ): Solid {
    let connector: { name: string; seat: number } | undefined;
    if (typeof diameter === "object" && diameter !== null) {
      const spec = diameter;
      const h = resolveHole(spec);
      opts = { tag: spec.tag ?? freeTag(`${h.label}-hole`, ["-cut", "1"]), depth: h.depth, direction: spec.direction, counterbore: h.counterbore, countersink: h.countersink };
      diameter = h.diameter;
      if (spec.connector !== undefined) connector = { name: spec.connector, seat: h.seat };
    }
    positive(diameter, "hole diameter");
    const raw = (Array.isArray(points) && (Array.isArray(points[0]) || ArrayBuffer.isView(points[0])) ? points : [points]) as Vec3[];
    if (!raw.length) userError("hole needs at least one point");
    const pts = raw.map((p, i) => vec3(p, raw.length > 1 ? `hole: point ${i + 1}` : "hole point"));
    if (opts.depth !== undefined) positive(opts.depth, "hole depth");
    if (opts.counterbore) (positive(opts.counterbore.diameter, "hole counterbore diameter"), positive(opts.counterbore.depth, "hole counterbore depth"));
    if (opts.countersink) (positive(opts.countersink.diameter, "hole countersink diameter"), optNum(opts.countersink.angle, "hole countersink angle"));
    const dir = axisVec(opts.direction ?? ([0, 0, -1] as Vec3), "hole direction");
    const bb = kBBox(this.record.shape);
    const depth = opts.depth ?? 2 * Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) + 1;
    const r = diameter / 2;
    // half cross-section (radius along local x, depth along local −y), revolved about the axis
    const prof: [number, number][] = [[0, 0.01]];
    if (opts.counterbore) {
      const cr = opts.counterbore.diameter / 2;
      prof.push([cr, 0.01], [cr, -opts.counterbore.depth], [r, -opts.counterbore.depth]);
    } else if (opts.countersink) {
      const sr = opts.countersink.diameter / 2;
      const ang = ((opts.countersink.angle ?? 90) / 2) * (Math.PI / 180);
      const recess = opts.countersink.recess ?? 0;
      // start 0.01 above the surface on the cone's own line, so the countersink is `diameter` at the surface
      if (recess > 0) prof.push([sr, 0.01], [sr, -recess]);
      else prof.push([sr + 0.01 * Math.tan(ang), 0.01]);
      prof.push([r, -recess - (sr - r) / Math.tan(ang)]);
    } else prof.push([r, 0.01]);
    prof.push([r, -depth], [0, -depth]);
    const tag = opts.tag;
    let result: Solid = this;
    const tools: Solid[] = [];
    pts.forEach((p, k) => {
      // local plane containing the axis: x ⟂ dir, y = −dir
      const x = Math.abs(dir[2]) < 0.9 ? vec.unit(vec.cross(dir, [0, 0, 1])) : vec.unit(vec.cross(dir, [1, 0, 0]));
      const pl = new Plane(p, vec.cross(x, vec.scale(dir, -1)), x);
      const sk = sketch(pl, { tag: tag ? `${tag}${pts.length > 1 ? k + 1 : ""}-profile` : undefined }).polyline(prof, { tag: "wall" });
      tools.push(sk.revolve(360, { axis: { origin: p, direction: vec.scale(dir, -1) as Vec3 }, tag: tag ? `${tag}${pts.length > 1 ? k + 1 : ""}` : undefined }));
    });
    result = booleanOp("subtract", this, tools, { tag: tag ? `${tag}-cut` : undefined });
    if (connector) {
      const seat = connector.seat;
      result = result.connector(connector.name, pts.map((p) => ({ origin: vec.add(p, vec.scale(dir, seat)), axis: vec.scale(dir, -1) as Vec3 })));
    }
    return result;
  }

  /**
   * Hex nut pockets (ISO 4032 nuts) at `points`, e.g. `.nutTrap(pts, { size: "M3" })` under the
   * surface, `{ size: "M3", inset: 4, slot: "X" }` for a captive nut that slides in from the side.
   * Pair it with `.hole(pts, { screw: "M3" })` for the bolt. See `NutTrapOpts`.
   */
  nutTrap(points: Vec3[] | Vec3, opts: NutTrapOpts): Solid {
    const pts = (Array.isArray(points[0]) ? points : [points]) as Vec3[];
    if (!pts.length) userError("nutTrap needs at least one point");
    const { tools, seats, label } = nutTrapTools(this, pts, opts);
    let out = booleanOp("subtract", this, tools, { tag: opts.tag ?? freeTag(label) });
    if (opts.connector !== undefined) out = out.connector(opts.connector, seats);
    return out;
  }

  // ---------- appearance ----------
  /**
   * Part color: a hex string (`"#4a7bd0"`), or `color.auto()` / `color.rgb(hex)` from the part tools.
   * A hex with alpha (`"#4a7bd080"`, `"#48f8"`) also sets the opacity.
   */
  color(c: ColorSpec | string): Solid {
    if (typeof c !== "string") {
      if (c?.kind === "auto") return new Solid(this.record, { ...this.meta, color: c });
      if (c?.kind !== "rgb") userError(`color(c): c must be a hex string like "#4a7bd0", color.auto() or color.rgb(hex)`);
      c = c.hex;
    }
    const { hex, alpha } = parseHex(c);
    const meta = { ...this.meta, color: { kind: "rgb" as const, hex } };
    return new Solid(this.record, alpha === undefined ? meta : { ...meta, appearance: { ...this.meta.appearance, opacity: alpha } });
  }
  /** See-through parts: 1 = opaque (default) … 0 = invisible. Shorthand for `.appearance({ opacity })`. */
  opacity(opacity: number): Solid {
    return this.appearance({ opacity });
  }
  /**
   * Color and finish in one call; fields left out keep their current value.
   * `.appearance({ color: "#9ec5ff", opacity: 0.35, roughness: 0.1 })` reads as tinted glass,
   * `.appearance({ metalness: 1, roughness: 0.3 })` as machined metal.
   */
  appearance(a: Appearance & { color?: ColorSpec | string }): Solid {
    if (!a || typeof a !== "object") userError(`appearance(a): a must be an object like { opacity: 0.4, roughness: 0.2 }`);
    const { color, ...rest } = a;
    const base = color === undefined ? this : this.color(color);
    const out: Appearance = { ...base.meta.appearance };
    for (const k of ["opacity", "roughness", "metalness"] as const) {
      const v = rest[k];
      if (v === undefined) continue;
      if (typeof v !== "number" || !(v >= 0 && v <= 1)) userError(`appearance ${k} must be a number from 0 to 1 (got ${JSON.stringify(v)})`);
      out[k] = v;
    }
    for (const k of Object.keys(rest)) if (!["opacity", "roughness", "metalness"].includes(k)) userError(`appearance has no "${k}"; use color, opacity, roughness or metalness`);
    return new Solid(base.record, { ...base.meta, appearance: out });
  }
  /**
   * Name a frame on this part for assembly joints to attach to: `lid.at("hinge")` in an assembly.
   * `at` is one face, edge or vertex (a hole's cylindrical face gives its axis, a planar face its
   * center and normal), a plane, or `{ origin: [x, y, z], axis: "X" }`. Built from geometry, it
   * follows the part when params change; later moves (translate, rotate, mirror) carry it along.
   * Several faces/edges/vertices (a pattern of holes), or an array of frames, give one frame each:
   * pick one in an assembly with `base.at("bolt", i)` (0-based; a selection is ordered by x, then
   * y, then z of each frame's origin; an array keeps its order).
   */
  connector(name: string, at: FrameSpec | FrameSpec[]): Solid {
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) userError(`connector name "${name}" must be an identifier (letters, digits, _ or -)`);
    const what = `connector("${name}")`;
    let frames: ConnectorFrame[];
    if (Array.isArray(at)) frames = at.map((a) => toFrame(a, what));
    else if (at instanceof EntitySet && at.length > 1) frames = at.indices.map((i) => toFrame(new EntitySet(at.record, at.kind, [i]), what)).sort(byOrigin);
    else frames = [toFrame(at, what)];
    if (!frames.length) userError(`${what}: nothing to attach to (the selection or array is empty)`);
    return new Solid(this.record, { ...this.meta, connectors: { ...this.meta.connectors, [name]: frames } });
  }
  /** Material for mass: a `MATERIALS` key ("pla", "petg", "abs", "nylon", "aluminum", "steel", "stainless", "brass", "wood") or `{ name, density }` (g/cm³). */
  material(m: Material | string): Solid {
    const mat = typeof m === "string" ? (MATERIALS[m.toLowerCase()] ?? userError(`unknown material "${m}"; use one of ${Object.keys(MATERIALS).join(", ")} or { density }`)) : m;
    return new Solid(this.record, { ...this.meta, material: mat });
  }

  // ---------- inspection ----------
  /** Volume in mm³. */
  volume(): number {
    return kMass(this.record.shape).volume;
  }
  /** Surface area in mm². */
  area(): number {
    return kMass(this.record.shape).area;
  }
  /** Centroid (world mm). */
  centerOfMass(): Vec3 {
    return kMass(this.record.shape).centroid;
  }
  /** Axis-aligned bounds `{ min, max, size }` (world mm). Handy for placing things relative to a solid. */
  boundingBox(): BBox & { size: Vec3 } {
    const b = kBBox(this.record.shape);
    return { ...b, size: [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]] };
  }
  /** Mass in grams, from the material density (g/cm³; default 1). */
  mass(): number {
    return (this.volume() / 1000) * (this.meta.material?.density ?? 1);
  }
  /** Whether the shape passes the kernel's validity check (BRepCheck). */
  isValid(): boolean {
    return kValid(this.record.shape);
  }

  /** @internal resolve an edges/faces argument to indices on this solid */
  resolve(arg: EdgesArg | FacesArg, kind: EntityKind, what: string): number[] {
    let idx: number[];
    if (typeof arg === "string") idx = [...EntitySet.fromSelector(this.record, kind, arg).indices];
    else if (Array.isArray(arg)) idx = [...new Set(arg.flatMap((s) => checkKind(s, kind, what).in(this.record)))];
    else if (arg instanceof EntitySet) idx = checkKind(arg, kind, what).in(this.record);
    else return userError(`${what} expects ${kind}s: a selection like base.${kind}s(">Z") or a selector string`);
    if (!idx.length) userError(`${what}: no ${kind}s selected`);
    return idx;
  }
}

/** Selection by history: `{ createdBy: "finUnion" }`, optionally narrowed by a selector string (`where: "%line"`). */
export type SelectOpts = {
  /** The operation(s) that created the entities: tag, op id or the solid it returned. */
  createdBy?: OpRef | OpRef[];
  /** A selector string to narrow with, e.g. `">Z"` or `"%circle"`. */
  where?: string;
};

function select(r: OpRecord, kind: EntityKind, sel?: string | SelectOpts): EntitySet {
  if (sel === undefined || typeof sel === "string") return EntitySet.fromSelector(r, kind, sel);
  if (typeof sel !== "object" || sel === null) return userError(`${kind}s(selector): expected a selector string or { createdBy, where } (got ${JSON.stringify(sel)})`);
  for (const k of Object.keys(sel)) if (k !== "createdBy" && k !== "where") userError(`${kind}s({ ... }) has no "${k}"; use createdBy and/or where`);
  let set = EntitySet.fromSelector(r, kind, sel.where);
  if (sel.createdBy !== undefined) set = set.createdBy(sel.createdBy);
  if (!set.length) warn(`${kind}s(${JSON.stringify(sel)}) matched no ${kind}s`);
  return set;
}

function checkKind(s: EntitySet, kind: EntityKind, what: string) {
  if (!(s instanceof EntitySet)) userError(`${what} expects ${kind}s`);
  if (s.kind !== kind) userError(`${what} expects ${kind}s but got ${s.kind}s`);
  return s;
}

function splitOpts(args: (Solid | OpOpts)[]): [Solid[], OpOpts] {
  const solids = args.filter((a): a is Solid => a instanceof Solid);
  const opts = (args.find((a) => !(a instanceof Solid)) as OpOpts) ?? {};
  if (!solids.length) userError("boolean needs at least one other solid");
  return [solids, opts];
}

/** @internal */
export function booleanOp(kind: "union" | "subtract" | "intersect", a: Solid, others: Solid[], opts: OpOpts): Solid {
  for (const b of others) if (!(b instanceof Solid)) userError(`${kind} expects solids`);
  const A = a.record;
  const tools = others.map((o) => o.record);
  const rec = runOp({
    type: kind,
    tag: opts.tag,
    params: {},
    inputs: [A, ...tools],
    build: () => ({ built: kBooleanMany(kind, A.shape, tools.map((t) => t.shape)), historyOptions: { generatedFrom: ["edge"] } }),
  });
  return new Solid(rec, a.meta);
}

function transformOp(s: Solid, type: string, t: Parameters<typeof kTransform>[1], opts: OpOpts, role?: string): Solid {
  const input = s.record;
  const rec = runOp({
    type,
    tag: opts.tag,
    params: { t, role },
    inputs: [input],
    build: () => {
      const built = kTransform(input.shape, t);
      built.maker?.delete?.();
      return {
        built: { shape: built.shape, maker: null },
        // a transform maps entity i to entity i; plain moves keep names, copies get a role
        history: (topo) => {
          const h = identityHistory(topo);
          if (role) for (const k of ["face", "edge", "vertex"] as const) for (const o of h[k]) for (const x of o) x.rel = "generated";
          return h;
        },
        roles: role ? ({ topo }) => ({ face: topo.faces.items.map(() => role) }) : undefined,
      };
    },
  });
  const connectors = s.meta.connectors && Object.fromEntries(Object.entries(s.meta.connectors).map(([k, fs]) => [k, fs.map((f) => transformFrame(f, t))]));
  return new Solid(rec, connectors ? { ...s.meta, connectors } : s.meta);
}

function patternOp(s: Solid, count: number, trsf: (k: number) => Parameters<typeof kTransform>[1], opts: OpOpts): Solid {
  int(count, "pattern count", 1);
  if (count === 1) return s;
  // instance 0 keeps its names; instance k is a copy whose faces are named `copy · #k · (original)`
  const copies = [...Array(count - 1)].map((_, i) => transformOp(s, "copy", trsf(i + 1), {}, `#${i + 1}`));
  return booleanOp("union", s, copies, opts);
}

/** Heuristic, agent-friendly explanation when a fillet/chamfer is too big. */
function explainRadius(what: string, r: number, rec: OpRecord, edges: number[]): string | undefined {
  let minWidth = Infinity;
  for (const e of edges) {
    const ei = edgeOf(rec, e);
    for (const f of rec.topo.edgeFaces[e] ?? []) {
      const fi = faceOf(rec, f);
      if (fi.surface !== "plane" || !ei.direction) continue;
      // width of the face measured perpendicular to the edge, within the face plane
      const across = vec.unit(vec.cross(fi.normal, ei.direction));
      const vs = new Set<number>();
      for (const fe of rec.topo.faceEdges[f] ?? []) for (const v of rec.topo.edgeVertices[fe] ?? []) vs.add(v);
      const proj = [...vs].map((v) => vec.dot(vertexOf(rec, v), across));
      if (proj.length >= 2) minWidth = Math.min(minWidth, Math.max(...proj) - Math.min(...proj));
    }
  }
  if (Number.isFinite(minWidth) && r >= minWidth - 1e-9) return `${what} ${fmt(r)} exceeds adjacent face width ${fmt(minWidth)}; use a value below ${fmt(minWidth)}`;
  if (Number.isFinite(minWidth)) return `${what} ${fmt(r)} failed (adjacent faces are at least ${fmt(minWidth)} wide); try a smaller value or fewer edges`;
  return `${what} ${fmt(r)} failed; try a smaller value or select fewer edges`;
}

const fmt = (x: number) => String(Math.round(x * 1000) / 1000);

/** "#rgb", "#rgba", "#rrggbb" or "#rrggbbaa" -> six-digit hex and the alpha (0..1), if given. */
function parseHex(input: string): { hex: string; alpha?: number } {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(input);
  if (!m) userError(`color "${input}" must be a hex color like "#4a7bd0" (or "#4a7bd080" with alpha)`);
  let h = m![1].toLowerCase();
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  return { hex: `#${h.slice(0, 6)}`, alpha: h.length === 8 ? Math.round((parseInt(h.slice(6), 16) / 255) * 1000) / 1000 : undefined };
}

/** Named materials for `solid.material(name)` (density in g/cm³). */
export const MATERIALS: Record<string, Material> = {
  pla: { name: "PLA", density: 1.24 },
  petg: { name: "PETG", density: 1.27 },
  abs: { name: "ABS", density: 1.04 },
  nylon: { name: "Nylon", density: 1.14 },
  aluminum: { name: "Aluminum 6061", density: 2.7 },
  steel: { name: "Steel", density: 7.85 },
  stainless: { name: "Stainless steel", density: 8.0 },
  brass: { name: "Brass", density: 8.5 },
  wood: { name: "Wood (pine)", density: 0.5 },
};

// ---------- primitives ----------
/**
 * Box `w` (x) × `d` (y) × `h` (z) mm. Its corner is at the origin (x 0..w, y 0..d, z 0..h) unless
 * `center: true` (centered on the origin) or `center: "xy"` (centered in x and y, z 0..h). Faces are
 * named by direction: `xmin`, `xmax`, `ymin`, `ymax`, `zmin`, `zmax`. Move it with `.translate`.
 * @example box(40, 30, 10, { center: "xy", tag: "base" })
 */
export function box(w: number, d: number, h: number, opts: OpOpts & { center?: boolean | "xy" } = {}): Solid {
  positive(w, "box width");
  positive(d, "box depth");
  positive(h, "box height");
  const corner: Vec3 = opts.center === true ? [-w / 2, -d / 2, -h / 2] : opts.center === "xy" ? [-w / 2, -d / 2, 0] : [0, 0, 0];
  const rec = runOp({
    type: "box",
    tag: opts.tag,
    params: { w, d, h, corner },
    inputs: [],
    build: () => ({ built: kBox(w, d, h, corner), roles: ({ topo }) => ({ face: topo.faces.items.map((f: any) => dirRole(faceOfShape(f))) }) }),
  });
  return new Solid(rec);
}

/**
 * Cylinder of `radius` (not diameter) and `height` mm, from `at` (default origin) along `axis`
 * (default "Z"), or centered on `at` with `center: true`. Faces: `side`, `cap.start`, `cap.end`.
 * @example cylinder(3, 20, { at: [10, 0, -5], tag: "bore" }) // z −5..15
 */
export function cylinder(radius: number, height: number, opts: OpOpts & { at?: Vec3; axis?: AxisLike; center?: boolean } = {}): Solid {
  positive(radius, "cylinder radius");
  positive(height, "cylinder height");
  const ax = axisVec(opts.axis ?? "Z", "cylinder axis");
  const base: Vec3 = opts.at === undefined ? [0, 0, 0] : vec3(opts.at, "cylinder at");
  const origin: Vec3 = opts.center ? vec.add(base, vec.scale(ax, -height / 2)) : base;
  const rec = runOp({
    type: "cylinder",
    tag: opts.tag,
    params: { radius, height, origin, ax },
    inputs: [],
    build: () => ({
      built: kCylinder(radius, height, origin, ax),
      roles: ({ topo }) => ({ face: topo.faces.items.map((f: any) => { const i = faceOfShape(f); return i.surface === "plane" ? (vec.dot(i.normal, ax) > 0 ? "cap.end" : "cap.start") : "side"; }) }),
    }),
  });
  return new Solid(rec);
}

const faceOfShape = (f: any) => faceInfo(f);
function dirRole(i: ReturnType<typeof faceInfo>): string {
  const n = i.normal;
  const ax = ["x", "y", "z"][[0, 1, 2].reduce((a, b) => (Math.abs(n[b]) > Math.abs(n[a]) ? b : a), 0)];
  const sign = n[[0, 1, 2].reduce((a, b) => (Math.abs(n[b]) > Math.abs(n[a]) ? b : a), 0)] > 0 ? "+" : "-";
  return `${ax}${sign === "+" ? "max" : "min"}`;
}

export type { KernelError };

/**
 * Thicken faces (a sheet) into a solid of `thickness` mm along their normals.
 * @example thicken(boss.faces("%cylinder"), 1) // a 1 mm skin around a cylinder
 */
export function thicken(faces: EntitySet, thickness: number, opts: OpOpts = {}): Solid {
  if (!(faces instanceof EntitySet) || faces.kind !== "face" || !faces.length) userError("thicken(faces, t) needs a face selection, e.g. thicken(part.faces(\">Z\"), 2)");
  num(thickness, "thicken thickness");
  if (thickness === 0) userError("thicken thickness must be non-zero");
  const input = faces.record;
  const idx = [...faces.indices];
  const rec = runOp({
    type: "thicken",
    tag: opts.tag,
    params: { faces: idx, thickness },
    inputs: [input],
    build: () => {
      const shape = idx.length === 1 ? entityShape(input, "face", idx[0]) : compound(idx.map((i) => entityShape(input, "face", i)));
      return { built: kThicken(shape, thickness), historyOptions: { generatedFrom: ["edge"] } };
    },
  });
  return new Solid(rec);
}

/** Frames in a stable order: by origin x, then y, then z (to a hundredth of a mm). */
const byOrigin = (a: ConnectorFrame, b: ConnectorFrame) => {
  for (let i = 0; i < 3; i++) {
    const d = Math.round(a.origin[i] * 100) - Math.round(b.origin[i] * 100);
    if (d) return d;
  }
  return 0;
};
