// The engine: holds a document's scripts + overrides, regenerates parts through the per-op
// cache, and answers geometry queries. Environment-agnostic: runs in the browser worker, in
// the headless engine pool, and under bun test.
import { noteKernelFault, faultMessage, boundingBox, massProps, isValid, pointDistance, edgeTangent, isSmoothEdge, explore, exportSTEP, boolean as kBoolean, meshTolerances, tessellate, scoped, placed, topology, deleteTopology, writeBrep, readBrep, type Topology, type Shape, type EntityKind, type MeshData, type MeshQuality, type Vec3, distance as kDistance, compound } from "@parasocial/kernel";
import { OpCache, entityName, names, nameIndex, select, isSeamEdge, resolveTarget, disambiguate, faceOf, edgeOf, vertexOf, lineage, entityShape, type OpRecord, type AnchorTargetRef, type Resolution } from "@parasocial/naming";
import * as api from "@parasocial/api";
import { PartContext, runPart, declareAssembly, bodyOf, parseStack, type Body, type SubAssembly, type PartDef, type PartRun, type Problem, type ParamDecl, type ColorSpec, type Appearance, type Material, type PartMeta, type AssemblyDef, type ConnectorFrame, type OpTiming, type JointType, type SourceRef, SI_DEFAULT, UNITS } from "@parasocial/api/internal";
import { loadModule, mapScriptFrame, ScriptError } from "./loader";
import { sourcePart } from "./protocol";
import { evaluateExpression, type EvaluateResult } from "./evaluate";
import { zipSync, strToU8 } from "fflate";

export type DocumentState = {
  scripts: Record<string, string>;
  /** part id -> param name -> expression/value, for the active configuration */
  overrides?: Record<string, Record<string, string | number>>;
  units?: { length: string; angle: string };
};

/**
 * A part a studio exports: `export default part(...)` is `<stem>`, `export const lid = part(...)` is `<stem>:lid`.
 * `studio` is the studio's display name: its `export const name = "..."`, else the file stem;
 * `studioDescription` is its `export const description = "..."`.
 */
export type PartInfo = { id: string; file: string; export: string; name: string; studio: string; studioDescription?: string };

/**
 * An assembly a studio exports (`export default assembly(...)`). It holds its own copies of the
 * parts it joins (instances): `<assembly id>/<part id>` for a part named directly (placed where
 * it's modeled), `<assembly id>/<part id>@<name>` for more copies from `insert`, and
 * `<assembly id>/<sub id>@<name>/<part id>` for the parts of an inserted assembly (a scope). The
 * source parts stay put in their studios. Joints and `fixed` name instances.
 */
export type AssemblyInfo = {
  id: string;
  file: string;
  export: string;
  name: string;
  studio: string;
  studioDescription?: string;
  /** From `assembly(name, body, { description, partNumber })`. */
  description?: string;
  partNumber?: string;
  /** The assembly's copies of parts, inserted ones first, then in the order the script names them. */
  instances: AssemblyInstance[];
  /** Inserted assemblies, parents before the ones they insert. */
  subs: AssemblySub[];
  /** Instances that never move (explicit `fix`; the solver also keeps each group's first part still). */
  fixed: string[];
  joints: AssemblyJoint[];
  /** Joints tied to each other (gear, rack and pinion, screw, linear), by joint name. */
  relations: AssemblyRelation[];
  problems: Problem[];
};

/**
 * Two joints' values tied together: b = ratio·a + offset, each in its own unit (degrees, mm).
 * `ia`/`ib` pick the joint variable (a cylindrical joint: 0 angle, 1 travel); the units are already converted.
 */
export type AssemblyRelation = { kind: "gear" | "rackPinion" | "screw" | "linear"; a: string; ia: number; b: string; ib: number; ratio: number; offset: number; scope: string; source?: SourceRef };

/** An assembly's copy of a part: same geometry as `part`, moved by the assembly's joints. */
export type AssemblyInstance = {
  id: string;
  part: string;
  /** The scope it's in: the assembly's id, or an inserted assembly's (`AssemblySub.id`). */
  scope: string;
  /** The copy's name, from `insert(part, { name })`. */
  name?: string;
  /** Where the script placed it, in its scope's coordinates. */
  place?: PartPose;
};

/** An inserted assembly: a scope its parts are laid out in, then placed in its parent scope as a whole. */
export type AssemblySub = { id: string; parent: string; assembly: string; name?: string; place?: PartPose };

/** A connector on a part, by name, and which of its frames when it has several. */
export type ConnectorAt = { connector: string; index?: number };

export type AssemblyJoint = {
  /** Stable key: dragged positions are saved under it. */
  name: string;
  /** The script named it (`{ name: "tilt" }`); otherwise the name is the two part ids. */
  named: boolean;
  type: JointType;
  /** Instance ids. */
  a: string;
  b: string;
  /** The scope that declared it (the assembly, or an inserted one): frames are in its coordinates. */
  scope: string;
  /**
   * Where it sits: a connector of a (source) part, resolved from its regeneration (`owner`: the
   * instance it's on, where it's at home); a frame in the scope's home coordinates; or connector to
   * connector (`mate`: one on a's part, one on b's; `flip` turns b's half a turn about its x).
   */
  at: ({ part: string; owner?: string } & ConnectorAt) | { frame: ConnectorFrame } | { mate: { a: ConnectorAt; b: ConnectorAt }; flip: boolean };
  limits: ({ min?: number; max?: number } | null)[];
  value: number[];
  overlap: boolean;
  source?: SourceRef;
};

/** Where two parts overlap: the shared volume, meshed in part `a`'s own coordinates. */
export type Interference = { a: string; b: string; volume: number; mesh?: MeshData };

/** A rigid transform from a part's modeled pose: rotation (row-major 3×3) and translation. */
export type PartPose = { r: number[]; t: Vec3 };

export type FaceMeta = { surface: string; area: number; center: Vec3; normal: Vec3; radius?: number; axis?: Vec3; origin?: Vec3 };
export type EdgeMeta = { curve: string; length: number; mid: Vec3; radius?: number; direction?: Vec3; center?: Vec3; axis?: Vec3; seam?: boolean; /** faces meet tangent-continuously here (fillet boundary, coplanar split): not drawn */ smooth?: boolean };

export type PartResult = {
  part: string;
  file: string;
  name: string;
  ok: boolean;
  /** Geometry is the last good result (an op failed / script error). */
  partial: boolean;
  /** Nothing to show at all (never generated successfully). */
  empty: boolean;
  problems: Problem[];
  params: ParamDecl[];
  color?: ColorSpec;
  appearance?: Appearance;
  material?: Material;
  /** Part number, description, vendor (from `part(name, body, options)`). */
  meta?: PartMeta;
  /** Named frames for assembly joints (part coordinates): one per connector, or several for a pattern. */
  connectors?: Record<string, ConnectorFrame[]>;
  quality: MeshQuality;
  mesh?: MeshData;
  faces: FaceMeta[];
  edges: EdgeMeta[];
  vertices: Vec3[];
  /** face index -> bounding edge indices (for face outlines) */
  faceEdges: number[][];
  bbox?: { min: Vec3; max: Vec3 };
  mass?: { volume: number; area: number; mass: number; centroid: Vec3 };
  /** ms; ops: time in geometry operations, opCount of them ran (cache misses), slowest: the longest of them, slowest first. */
  timings: { total: number; script: number; ops: number; mesh: number; cacheHits: number; cacheMisses: number; opCount?: number; slowest?: OpTiming[] };
  /** hash of the final op (derived-data cache key component) */
  key?: string;
  /**
   * The geometry is the one the caller already has (`known` matched `key`): mesh, faces, edges,
   * vertices, faceEdges, bbox and mass were skipped; everything else is fresh.
   */
  unchanged?: boolean;
};

export type EntityDescription = {
  part: string;
  kind: EntityKind;
  index: number;
  name: string;
  type: string;
  area?: number;
  length?: number;
  normal?: Vec3;
  radius?: number;
  axis?: Vec3;
  center: Vec3;
  createdBy?: { id: string; type: string; tag?: string; source?: { file: string; line: number; col?: number }; chain?: { file: string; line: number; fn?: string }[] };
  neighbors: string[];
};

const freeze = <T>(o: T): T => {
  const seen = new Set<unknown>();
  const f = (x: any) => {
    if (!x || (typeof x !== "object" && typeof x !== "function") || seen.has(x)) return;
    seen.add(x);
    Object.freeze(x);
    if (typeof x === "function" && x.prototype) f(x.prototype);
    for (const k of Object.getOwnPropertyNames(x)) {
      try {
        f(x[k]);
      } catch {}
    }
  };
  f(o);
  return o;
};

/** The frozen `parasocial` module scripts see. */
export const API_MODULE: Record<string, unknown> = freeze({ ...api, __esModule: true });

export class Engine {
  readonly cache = new OpCache(4);
  private scripts = new Map<string, string>();
  private overrides: NonNullable<DocumentState["overrides"]> = {};
  private units = SI_DEFAULT;
  /** latest run per part (for queries) */
  private runs = new Map<string, PartRun>();
  /** last good record per part: the viewport never goes blank */
  private lastGood = new Map<string, OpRecord>();
  /** Script paths each part's last regeneration read or looked for (see `affected`). */
  private deps = new Map<string, Set<string>>();
  private seed = 1;
  /** Discovered parts (evaluating every studio's top level); null = stale. */
  private discovered: PartInfo[] | null = null;
  /** Last discovered parts per studio: a studio that fails to load keeps its parts (with the error). */
  private lastByFile = new Map<string, PartInfo[]>();
  /** Assemblies found by the last discovery, and which part id each discovered PartDef is. */
  private assemblyDefs: { info: Omit<AssemblyInfo, "instances" | "subs" | "fixed" | "joints" | "relations" | "problems">; def: AssemblyDef }[] = [];
  private assemblyIdOf = new Map<AssemblyDef, string>();
  private partIdOf = new Map<PartDef, string>();
  private assemblyCache: AssemblyInfo[] | null = null;
  /** Dragged assembly positions: instance -> transform from its modeled pose. */
  private poses = new Map<string, PartPose>();
  private interferenceCache = new Map<string, { volume: number; mesh?: MeshData }>();
  /** Parts another engine regenerates (multi-worker engine page): their shapes, for measure, interference and export. */
  private foreign = new Map<string, ForeignShape>();
  /** Shape-derived data survives script reruns; material and provenance remain fresh. */
  private geometry = new WeakMap<OpRecord, { bbox: NonNullable<PartResult["bbox"]>; faces: FaceMeta[]; edges: EdgeMeta[]; vertices: Vec3[]; faceEdges: number[][]; mass?: ReturnType<typeof massProps> }>();
  private meshCache = new Map<string, { rec: OpRecord; mesh: MeshData; bytes: number }>();
  private meshBytes = 0;
  private boxes = new WeakMap<object, Box>();
  private volumes = new Map<string, number>();

  setDocument(doc: DocumentState) {
    this.scripts = new Map(Object.entries(doc.scripts));
    this.discovered = null;
    this.overrides = doc.overrides ?? {};
    if (doc.units) this.units = { length: UNITS[doc.units.length] ?? SI_DEFAULT.length, angle: UNITS[doc.units.angle] ?? SI_DEFAULT.angle };
  }
  setScript(path: string, content: string | null) {
    if (content === null) this.scripts.delete(path);
    else this.scripts.set(path, content);
    this.discovered = null;
  }
  setOverrides(part: string, o: Record<string, string | number>) {
    this.overrides[part] = o;
  }
  getScripts() {
    return Object.fromEntries(this.scripts);
  }

  /**
   * Evaluate `expr` in `script`'s module scope (its exports, top-level bindings and imports). Params
   * read `part`'s overrides (its active configuration), else only shared overrides and defaults.
   */
  evaluate(script: string, expr: string, part?: string): EvaluateResult {
    const id = part === undefined ? undefined : sourcePart(part);
    const info = id === undefined ? undefined : this.partInfos().find((p) => p.id === id);
    if (id !== undefined && !info) throw new Error(`no part "${part}". Parts: ${this.parts().join(", ") || "none"}`);
    const ctx = new PartContext({ part: id ?? "evaluate", file: info?.file ?? script, cache: this.cache, overrides: (id && this.overrides[id]) || {}, sharedOverrides: this.overrides[SHARED] ?? {}, units: this.units, mapFrame: mapScriptFrame, isUserFile: (f) => /^(studios|lib)\//.test(f) });
    return evaluateExpression({ scripts: this.scripts, api: API_MODULE, seed: this.seed, script, expr, ctx });
  }

  /** Part ids in stable order (by script path, then export order). */
  parts(): string[] {
    return this.partInfos().map((p) => p.id);
  }

  /**
   * Every part the studios export. Loads all scripts in one module cache so a part
   * re-exported by another studio (or imported to build on) is listed once, under the studio
   * that defines it: dependencies finish evaluating before their importers.
   */
  partInfos(): PartInfo[] {
    if (this.discovered) return this.discovered;
    const files = [...this.scripts.keys()].filter((p) => STUDIO_FILE.test(p)).sort();
    const cache = new Map<string, { exports: any }>();
    const loaded: [string, Record<string, any>][] = [];
    const failed = new Set<string>();
    for (const f of files) {
      try {
        loadModule(f, { scripts: this.scripts, api: API_MODULE, seed: this.seed, cache, onLoaded: (path, exports) => loaded.push([path, exports]) });
      } catch {
        failed.add(f);
      }
    }
    const owner = new Map<PartDef, string>();
    for (const [path, exports] of loaded) if (STUDIO_FILE.test(path)) for (const [, v] of exportEntries(exports)) if (isPartDef(v) && !owner.has(v)) owner.set(v, path);
    const exportsOf = new Map(loaded);
    const out: PartInfo[] = [];
    this.assemblyDefs = [];
    this.assemblyIdOf = new Map();
    this.partIdOf = new Map();
    this.assemblyCache = null;
    for (const f of files) {
      const stem = studioStem(f);
      const exports = exportsOf.get(f);
      if (failed.has(f) || !exports) {
        out.push(...(this.lastByFile.get(f) ?? [{ id: stem, file: f, export: "default", name: stem, studio: stem }]));
        continue;
      }
      const studio = studioName(exports) ?? stem;
      const about = studioDescription(exports);
      const studioDesc = about ? { studioDescription: about } : {};
      const list: PartInfo[] = [];
      const seen = new Set<PartDef>();
      // the default export first, then named exports in source order
      const entries = exportEntries(exports);
      for (const [key, v] of [...entries.filter(([k]) => k === "default"), ...entries.filter(([k]) => k !== "default")]) {
        if (!isPartDef(v) || owner.get(v) !== f || seen.has(v)) continue;
        seen.add(v);
        list.push({ id: key === "default" ? stem : `${stem}:${key}`, file: f, export: key, name: v.name, studio, ...studioDesc });
      }
      for (const [key, v] of [...entries.filter(([k]) => k === "default"), ...entries.filter(([k]) => k !== "default")])
        if (isAssemblyDef(v) && !this.assemblyIdOf.has(v)) {
          const id = key === "default" ? stem : `${stem}:${key}`;
          this.assemblyIdOf.set(v, id);
          this.assemblyDefs.push({ info: { id, file: f, export: key, name: v.name, studio, ...studioDesc, ...v.meta }, def: v });
        }
      // nothing exported yet: one placeholder part carries the "must export a part" error
      if (!list.length && !this.assemblyDefs.some((a) => a.info.file === f)) list.push({ id: stem, file: f, export: "default", name: stem, studio, ...studioDesc });
      this.lastByFile.set(f, list);
      out.push(...list);
    }
    for (const f of this.lastByFile.keys()) if (!this.scripts.has(f)) this.lastByFile.delete(f);
    for (const [def, path] of owner) {
      const exports = exportsOf.get(path)!;
      const key = exportEntries(exports).find(([, v]) => v === def)?.[0];
      if (key) this.partIdOf.set(def, key === "default" ? studioStem(path) : `${studioStem(path)}:${key}`);
    }
    return (this.discovered = out);
  }

  /**
   * Every assembly the studios export, flattened: the copies it names or inserts, the assemblies it
   * inserts (their copies and joints included), joints resolved to instance ids. Evaluates the
   * assembly bodies only (no geometry): connector frames come from each part's regeneration.
   */
  assemblies(): AssemblyInfo[] {
    this.partInfos();
    if (this.assemblyCache) return this.assemblyCache;
    const out: AssemblyInfo[] = [];
    for (const { info, def } of this.assemblyDefs) {
      const a: AssemblyInfo = { ...info, instances: [], subs: [], fixed: [], joints: [], relations: [], problems: [] };
      out.push(a);
      // a studio holds parts or assemblies, never both
      const own = this.lastByFile.get(info.file) ?? [];
      if (own.length) {
        a.problems.push({ severity: "error", kind: "runtime", message: `a studio exports parts or assemblies, not both: move ${own.map((p) => `"${p.name}"`).join(", ")} to another studio and import ${own.length > 1 ? "them" : "it"} here`, part: info.id, source: { file: info.file, line: 1 } });
        continue;
      }
      this.flatten(a, def, info.id, [def], new Map());
    }
    // the workspace shows every assembly a studio exports: one its other assembly inserts shows twice
    for (const a of out) {
      const by = out.find((b) => b !== a && b.file === a.file && b.subs.some((s) => s.assembly === a.id));
      if (!by) continue;
      const source = { file: a.file, line: exportLine(this.scripts.get(a.file) ?? "", a.export) };
      a.problems.push({ severity: "warning", kind: "runtime", message: `studio "${a.studio}" shows "${a.name}" twice: exported and inserted by "${by.name}". Export "${a.name}" from its own studio and import it here (${a.file.split("/").pop()}:${source.line})`, part: a.id, source });
    }
    return (this.assemblyCache = out);
  }

  /**
   * Add an assembly's copies and joints to `a`, in `scope` (the assembly itself, or where it's
   * inserted). Returns its root: the copy that holds it in place (its first fixed part, else the
   * first part of its first joint, the one the solver keeps still), which `fix(sub)` fixes;
   * `anchors` collects them per inserted assembly.
   */
  private flatten(a: AssemblyInfo, def: AssemblyDef, scope: string, stack: AssemblyDef[], anchors: Map<string, string>): string | undefined {
    const problem = (message: string, source?: SourceRef) =>
      a.problems.push({ severity: "error", kind: "runtime", message: source ? `${message} (${source.file.split("/").pop()}:${source.line})` : message, part: a.id, source: source ?? { file: a.file, line: 1 } });
    let decl;
    try {
      decl = declareAssembly(def);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      problem(err.message, sourceOf(err.stack ?? ""));
      return;
    }
    const firstJoint = a.joints.length;
    const partId = (p: PartDef, source?: SourceRef) => {
      const id = this.partIdOf.get(p);
      if (!id) problem(`the part "${p.name}" isn't exported by a studio, so it can't be in an assembly`, source);
      return id;
    };
    // a handle's key in this scope: "box:lid", "box:lid@2", "wheel@fl/hub" (a part of an inserted assembly)
    const keyOf = (h: Body | SubAssembly, source?: SourceRef): string | undefined => {
      if (isPartDef(h)) return partId(h, source);
      let base: string | undefined;
      if ("__instance" in h) base = partId(h.of, source);
      else {
        base = this.assemblyIdOf.get(h.of);
        if (!base) problem(`the assembly "${h.of.name}" isn't exported by a studio, so it can't be inserted`, source);
      }
      if (!base) return undefined;
      if (h.name !== undefined) base += `@${h.name}`;
      if (!h.within) return base;
      const w = keyOf(h.within, source);
      return w && `${w}/${base}`;
    };
    const has = (id: string) => a.instances.some((i) => i.id === id);
    // the instance a handle names: this scope's own copy is made the first time the script names it;
    // a part of an inserted assembly must be one of its copies
    const inst = (h: Body, source?: SourceRef) => {
      const key = keyOf(h, source);
      if (!key) return undefined;
      const id = `${scope}/${key}`;
      if (!isPartDef(h) && h.within) {
        if (!has(id)) return void problem(`"${h.within.of.name}" has no copy of "${h.of.name}"${h.name === undefined ? "" : ` named "${h.name}"`}`, source);
        return id;
      }
      if (!has(id)) a.instances.push({ id, part: isPartDef(h) ? key : sourcePart(id), scope, ...(!isPartDef(h) && h.name !== undefined && { name: h.name }) });
      return id;
    };
    const local = (id: string) => id.slice(scope.length + 1);

    // copies in the order the script makes or names them; inserted assemblies flatten in place
    for (const o of decl.order) {
      if ("body" in o) {
        if (isPartDef(o.body) || !o.body.within) inst(o.body);
        continue;
      }
      const ins = o.insert;
      const source = sourceOf(ins.stack);
      const h = ins.handle;
      if ("__instance" in h) {
        const id = inst(h, source);
        const i = id && a.instances.find((x) => x.id === id);
        if (i && ins.place) i.place = ins.place;
        continue;
      }
      if (stack.includes(h.of)) {
        problem(`"${h.of.name}" inserts itself (${[...stack, h.of].map((d) => d.name).join(" → ")})`, source);
        continue;
      }
      const key = keyOf(h, source);
      if (!key) continue;
      const sub = `${scope}/${key}`;
      a.subs.push({ id: sub, parent: scope, assembly: this.assemblyIdOf.get(h.of)!, ...(h.name !== undefined && { name: h.name }), ...(ins.place && { place: ins.place }) });
      const root = this.flatten(a, h.of, sub, [...stack, h.of], anchors);
      if (root) anchors.set(sub, root);
    }

    const fixed: string[] = [];
    for (const f of decl.fixed) {
      // a subassembly: its root, so it stays put and its own joints still move
      if ("__subassembly" in f) {
        const key = keyOf(f);
        const root = key && anchors.get(`${scope}/${key}`);
        if (root && !fixed.includes(root)) fixed.push(root);
        else if (key && !root) problem(`fix: "${f.of.name}"${f.name === undefined ? "" : ` "${f.name}"`} isn't inserted here, or has no parts`);
        continue;
      }
      const id = inst(f);
      if (id && !fixed.includes(id)) fixed.push(id);
    }
    // joints of an inserted assembly are named under it: "wheel@fl/spin"
    const prefix = scope === a.id ? "" : `${scope.slice(a.id.length + 1)}/`;
    const used = new Map<string, number>();
    const push = (j: Omit<AssemblyJoint, "name">, base: string) => {
      const full = prefix + base;
      const n = (used.get(full) ?? 0) + 1;
      used.set(full, n);
      const name = n > 1 ? `${full}#${n}` : full;
      a.joints.push({ name, ...j });
      return name;
    };
    const names = new Map<unknown, string>();
    if (scope === a.id) for (const f of fixed) !a.fixed.includes(f) && a.fixed.push(f);
    // in an inserted assembly, its fixed parts stay put relative to each other (the whole moves)
    else for (const f of fixed.slice(1)) push({ named: false, type: "fastened", a: fixed[0], b: f, scope, at: { frame: { origin: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] } }, limits: [], value: [], overlap: false }, `${local(fixed[0])}+${local(f)}`);

    for (const j of decl.joints) {
      const source = sourceOf(j.stack);
      const ia = inst(j.a, source),
        ib = inst(j.b, source);
      if (!ia || !ib) continue;
      if (ia === ib) {
        problem(`${j.type}(a, b): a and b are the same copy (${local(ia)})`, source);
        continue;
      }
      let at: AssemblyJoint["at"];
      if ("connector" in j.at) {
        const c = j.at.connector;
        const part = partId(c.part, source);
        if (!part) continue;
        const owner = keyOf(bodyOf(c));
        at = { part, connector: c.name, ...(c.index !== undefined && { index: c.index }), ...(owner && { owner: `${scope}/${owner}` }) };
      } else if ("mate" in j.at) {
        const [ca, cb] = j.at.mate;
        at = { mate: { a: { connector: ca.name, ...(ca.index !== undefined && { index: ca.index }) }, b: { connector: cb.name, ...(cb.index !== undefined && { index: cb.index }) } }, flip: j.at.flip };
      } else at = { frame: j.at.frame };
      names.set(j.handle, push({ named: j.name !== undefined, type: j.type, a: ia, b: ib, scope, at, limits: j.limits.map((r) => (r ? { min: r.min, max: r.max } : null)), value: j.value, overlap: j.overlap, source }, j.name ?? `${local(ia)}+${local(ib)}`));
    }
    // relations between this scope's joints (one whose joint had a problem is left out)
    for (const r of decl.relations) {
      const na = names.get(r.a),
        nb = names.get(r.b);
      if (na && nb) a.relations.push({ kind: r.kind, a: na, ia: r.ia, b: nb, ib: r.ib, ratio: r.ratio, offset: r.offset, scope, source: sourceOf(r.stack) });
    }
    return fixed[0] ?? a.joints[firstJoint]?.a ?? a.instances.find((i) => i.id.startsWith(`${scope}/`))?.id;
  }

  /** Dragged positions of instances (transforms from the modeled pose); those not listed sit where they're modeled. */
  setPoses(poses: Record<string, PartPose>) {
    this.poses = new Map(Object.entries(poses).filter(([, p]) => validPose(p)));
  }

  /** A part's shape where it's shown: moved by its assembly pose, if any. */
  private posedShape(part: string, shape = this.body(part).shape) {
    const p = this.poses.get(part);
    return p ? placed(shape, p.r, p.t) : shape;
  }

  /**
   * Where visible parts overlap. Pairs whose (posed) bounding boxes don't meet are skipped; each
   * overlap comes back meshed in part `a`'s own coordinates, so it rides along with `a`.
   * Contact (touching faces) isn't overlap: volumes below a hair are dropped.
   */
  interferences(parts: string[], ignore: [string, string][] = []): Interference[] {
    const skip = new Set(ignore.flatMap(([a, b]) => [`${a}\u0000${b}`, `${b}\u0000${a}`]));
    const items = parts.flatMap((p) => {
      // a part whose last run failed shows its last good geometry; the failed run's partial
      // result may already be released by the op cache
      const rec = this.foreign.get(sourcePart(p)) ?? (this.runs.get(sourcePart(p))?.ok ? this.shown(p) : this.lastGood.get(sourcePart(p)));
      if (!rec) return [];
      try {
        const bb = boundingBox(rec.shape);
        const pose = this.poses.get(p) ?? IDENTITY;
        return [{ part: p, rec, box: worldBox(bb, pose), pose, volume: massProps(rec.shape).volume }];
      } catch {
        return [];
      }
    });
    const out: Interference[] = [];
    const live = new Set<string>();
    for (let i = 0; i < items.length; i++)
      for (let k = i + 1; k < items.length; k++) {
        const A = items[i],
          B = items[k];
        if (skip.has(`${A.part}\u0000${B.part}`) || !boxesOverlap(A.box, B.box)) continue;
        // B in A's frame: A⁻¹·B
        const rel = composePose(invertPose(A.pose), B.pose);
        const key = `${A.rec.key}|${B.rec.key}|${[...rel.r, ...rel.t].map((v) => v.toFixed(6)).join(",")}`;
        live.add(key);
        let hit = this.interferenceCache.get(key);
        if (!hit) {
          hit = { volume: 0 };
          try {
            const r = kBoolean("intersect", A.rec.shape, placed(B.rec.shape, rel.r, rel.t));
            r.maker?.delete?.();
            const v = massProps(r.shape).volume;
            // touching faces and tangent contact leave numerical slivers: not a collision
            if (v > Math.max(1e-3, 1e-7 * Math.min(A.volume, B.volume))) {
              hit.volume = v;
              scoped(() => {
                const t = topology(r.shape);
                const bb = boundingBox(r.shape);
                const tol = meshTolerances(Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]), "coarse");
                hit!.mesh = tessellate(r.shape, t.faces, t.edges, tol.tolerance, tol.angular);
              });
            }
            r.shape.delete?.();
          } catch {}
          this.interferenceCache.set(key, hit);
        }
        if (hit.volume > 0) out.push({ a: A.part, b: B.part, volume: hit.volume, mesh: hit.mesh && cloneMesh(hit.mesh) });
      }
    // keep only what the current layout uses (plus a few recent, for drags back and forth)
    if (this.interferenceCache.size > 64) for (const k of [...this.interferenceCache.keys()].slice(0, this.interferenceCache.size - 64)) if (!live.has(k)) this.interferenceCache.delete(k);
    return out;
  }

  /**
   * `known`: the key of the geometry the caller already has at this quality; if it's still current, meshing is skipped.
   * Never throws: whatever goes wrong (including inside the kernel) is a problem on this part's result.
   */
  regenerate(part: string, quality: MeshQuality = "fine", known?: string): PartResult {
    // an assembly instance is its source part's geometry
    if (sourcePart(part) !== part) return { ...this.regenerate(sourcePart(part), quality, known), part };
    try {
      return this.regenerateUnsafe(part, quality, known);
    } catch (e) {
      const fault = noteKernelFault(e);
      const info = this.discovered?.find((p) => p.id === part);
      const file = info?.file ?? `studios/${part.split(":")[0]}.ts`;
      const message = fault ? `the geometry kernel crashed while regenerating ${part} (${faultMessage(e)}); the engine restarts` : `regenerating ${part} failed: ${(e as Error)?.message ?? e}`;
      return {
        part,
        file,
        name: info?.name ?? part,
        ok: false,
        partial: true,
        empty: true,
        problems: [{ severity: "error", kind: "runtime", message, part, source: { file, line: 1 } }],
        params: this.runs.get(part)?.params ?? [],
        quality,
        faces: [],
        edges: [],
        vertices: [],
        faceEdges: [],
        timings: { total: 0, script: 0, ops: 0, mesh: 0, cacheHits: 0, cacheMisses: 0 },
      };
    }
  }

  private regenerateUnsafe(part: string, quality: MeshQuality, known?: string): PartResult {
    const t0 = performance.now();
    this.dropForeign(part);
    const infos = this.partInfos();
    const info = infos.find((p) => p.id === part);
    const colon = part.indexOf(":");
    const file = info?.file ?? `studios/${colon < 0 ? part : part.slice(0, colon)}.ts`;
    const key = info?.export ?? (colon < 0 ? "default" : part.slice(colon + 1));
    this.cache.begin();
    const touched = new Set([file]);
    let def: PartDef | undefined;
    let problems: Problem[] = [];
    let run: PartRun | undefined;
    const tScript = performance.now();
    try {
      if (!this.scripts.has(file)) throw new ScriptError(`no script at ${file}`, file);
      const mod = loadModule(file, { scripts: this.scripts, api: API_MODULE, seed: this.seed, touched });
      def = mod[key];
      if (!isPartDef(def))
        throw new ScriptError(
          key === "default" ? `${file} must export a part: \`export default part("Name", () => ...)\`, or several as named exports: \`export const lid = part("Lid", () => ...)\`` : `${file} no longer exports the part "${key}"`,
          file,
          undefined,
          undefined,
          "runtime",
        );
    } catch (e) {
      problems.push(scriptProblem(e, part, file));
    }
    if (def) {
      const ctx = new PartContext({ part, file, cache: this.cache, overrides: this.overrides[part] ?? {}, sharedOverrides: this.overrides[SHARED] ?? {}, units: this.units, mapFrame: mapScriptFrame, isUserFile: (f) => /^(studios|lib)\//.test(f) });
      run = runPart(def, ctx);
      problems = run.problems;
      this.runs.set(part, run);
    }
    this.deps.set(part, touched);
    const scriptMs = performance.now() - tScript;
    let rec = run?.record;
    if (rec && run?.ok) this.lastGood.set(part, rec);
    if (!rec) rec = this.lastGood.get(part);
    // pin shown geometry so the cache doesn't release it
    const pinned = new Set([...this.lastGood.values()].flatMap((r) => lineage(r)));
    this.cache.sweep(pinned);

    const result: PartResult = {
      part,
      file,
      name: run?.name ?? def?.name ?? info?.name ?? part,
      ok: !!run?.ok && !problems.some((p) => p.severity === "error"),
      partial: !run?.ok,
      empty: !rec,
      problems,
      params: run?.params ?? [],
      color: run?.color,
      appearance: run?.appearance,
      material: run?.material ?? def?.meta?.material,
      meta: run?.meta ?? def?.meta,
      connectors: run?.connectors,
      quality,
      faces: [],
      edges: [],
      vertices: [],
      faceEdges: [],
      timings: { total: 0, script: scriptMs, ops: run?.timings.ops ?? 0, mesh: 0, cacheHits: run?.timings.cacheHits ?? 0, cacheMisses: run?.timings.cacheMisses ?? 0, opCount: run?.timings.opCount ?? 0, slowest: run?.timings.slowest ?? [] },
      key: rec?.key,
    };
    if (rec && known !== undefined && rec.key === known) result.unchanged = true;
    else if (rec) {
      try {
        this.describeResult(result, rec, quality, run);
      } catch (e) {
        // the script ran, but its result can't be measured or meshed: say so on this part, keep the rest
        const fault = noteKernelFault(e);
        const last = run?.ops.at(-1)?.callSite;
        const where = last ? ` (${last.file.split("/").pop()}:${last.line})` : "";
        const message = fault
          ? `the geometry kernel crashed while meshing ${result.name} (${faultMessage(e)})${where}; the engine restarts. Check the inputs of the last operations for NaN or huge values`
          : `couldn't mesh ${result.name}: ${(e as Error)?.message ?? e}${where}`;
        result.problems = [...result.problems, { severity: "error", kind: "operation", message, part, source: last ? { file: last.file, line: last.line, col: last.col } : { file, line: 1 } }];
        Object.assign(result, { ok: false, partial: true, empty: true, mesh: undefined, bbox: undefined, mass: undefined, faces: [], edges: [], vertices: [], faceEdges: [], key: undefined });
        if (this.lastGood.get(part) === rec) this.lastGood.delete(part);
      }
    }
    result.timings.total = performance.now() - t0;
    return result;
  }

  /** Bounding box, mesh, entity summaries and mass of a regenerated record (throws if it can't be meshed). */
  private describeResult(result: PartResult, rec: OpRecord, quality: MeshQuality, run?: PartRun) {
    let geometry = this.geometry.get(rec);
    if (!geometry) {
      const bb = scoped(() => boundingBox(rec.shape, { geometric: true }));
      if (![...bb.min, ...bb.max].every(Number.isFinite)) throw new Error("its geometry has invalid (NaN or infinite) coordinates");
      geometry = {
        bbox: bb,
        faces: rec.topo.faces.items.map((_, i) => {
          const f = faceOf(rec, i);
          return { surface: f.surface, area: f.area, center: f.center, normal: f.normal, radius: f.radius, axis: f.axis, origin: f.origin };
        }),
        edges: rec.topo.edges.items.map((_, i) => {
          const e = edgeOf(rec, i);
          return { curve: e.curve, length: e.length, mid: e.mid, radius: e.radius, direction: e.direction, center: e.center, axis: e.axis, seam: isSeamEdge(rec, i) || undefined, smooth: smoothEdge(rec, i) || undefined };
        }),
        vertices: rec.topo.vertices.items.map((_, i) => vertexOf(rec, i)),
        faceEdges: rec.topo.faceEdges.map((l) => [...l]),
      };
      this.geometry.set(rec, geometry);
    }
    result.bbox = { min: [...geometry.bbox.min], max: [...geometry.bbox.max] };
    result.faces = geometry.faces.map((f) => ({ ...f }));
    result.edges = geometry.edges.map((e) => ({ ...e }));
    result.vertices = geometry.vertices.map((v) => [...v] as Vec3);
    result.faceEdges = geometry.faceEdges.map((edges) => [...edges]);
    const meshKey = `${result.part}\0${quality}`;
    const cached = this.meshCache.get(meshKey);
    if (cached?.rec === rec) {
      this.meshCache.delete(meshKey);
      this.meshCache.set(meshKey, cached);
      // Results cross a transferable-buffer boundary. Never detach the cached mesh.
      result.mesh = cloneMesh(cached.mesh);
    } else {
      const tm = performance.now();
      const mesh = scoped(() => {
        const bb = geometry!.bbox;
        const diag = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]);
        const tol = meshTolerances(diag, quality);
        return tessellate(rec.shape, rec.topo.faces, rec.topo.edges, tol.tolerance, tol.angular);
      });
      result.timings.mesh = performance.now() - tm;
      if (cached) {
        this.meshBytes -= cached.bytes;
        this.meshCache.delete(meshKey);
      }
      const bytes = Object.values(mesh).reduce((sum, a) => sum + a.byteLength, 0);
      const budget = 64 * 1024 * 1024;
      if (bytes <= budget) {
        while (this.meshBytes + bytes > budget && this.meshCache.size) {
          const [key, oldest] = this.meshCache.entries().next().value!;
          this.meshCache.delete(key);
          this.meshBytes -= oldest.bytes;
        }
        this.meshCache.set(meshKey, { rec, mesh, bytes });
        this.meshBytes += bytes;
        result.mesh = cloneMesh(mesh);
      } else {
        result.mesh = mesh;
      }
    }
    if (quality === "fine") {
      const m = geometry.mass ??= scoped(() => massProps(rec.shape));
      result.mass = { volume: m.volume, area: m.area, centroid: [...m.centroid], mass: (m.volume / 1000) * (run?.material?.density ?? 1) };
    }
  }

  /**
   * The parts a change to these script paths can affect: those whose last regeneration read (or
   * looked for) one of them, and those never regenerated.
   */
  affected(paths: string[]): string[] {
    return this.parts().filter((p) => {
      const d = this.deps.get(p);
      return !d || paths.some((x) => d.has(x));
    });
  }

  /** Validity check (BRepCheck) as warnings; slow-ish, so run after the mesh is on screen. */
  check(part: string): Problem[] {
    const rec = this.shown(part);
    if (!rec) return [];
    return isValid(rec.shape) ? [] : [{ severity: "warning", kind: "invalid", message: `${part} geometry is not valid (BRepCheck); a boolean or fillet may have produced bad topology`, part }];
  }

  /** The record currently shown for a part (latest, or last good); an instance shows its source part's. */
  shown(part: string): OpRecord | undefined {
    const r = this.runs.get(sourcePart(part));
    return r?.record ?? this.lastGood.get(sourcePart(part));
  }

  run(part: string) {
    return this.runs.get(sourcePart(part));
  }

  /** Stable names for all entities of a part (lazily built; for cache metadata and describe). */
  names(part: string): Record<EntityKind, string[]> {
    const rec = this.need(part);
    return { face: names(rec, "face").map((n) => n.str), edge: names(rec, "edge").map((n) => n.str), vertex: names(rec, "vertex").map((n) => n.str) };
  }

  describe(part: string, kind: EntityKind, index: number): EntityDescription {
    const rec = this.need(part);
    const n = entityName(rec, kind, index);
    const creator = lineage(rec).find((o) => o.id === n.creator);
    const d: EntityDescription = {
      part,
      kind,
      index,
      name: n.str,
      type: kind,
      center: [0, 0, 0],
      neighbors: [],
      createdBy: creator && {
        id: creator.id,
        type: creator.type,
        tag: creator.tag,
        source: creator.callSite && { file: creator.callSite.file, line: creator.callSite.line, col: creator.callSite.col },
        chain: creator.callChain?.map((c) => ({ file: c.file, line: c.line, fn: c.fn })),
      },
    };
    if (kind === "face") {
      const f = faceOf(rec, index);
      Object.assign(d, { type: f.surface, area: f.area, normal: f.normal, radius: f.radius, axis: f.axis, center: f.center });
      const nb = new Set<number>();
      for (const e of rec.topo.faceEdges[index] ?? []) for (const g of rec.topo.edgeFaces[e] ?? []) if (g !== index) nb.add(g);
      d.neighbors = [...new Set([...nb].map((g) => entityName(rec, "face", g).str))];
    } else if (kind === "edge") {
      const e = edgeOf(rec, index);
      Object.assign(d, { type: e.curve, length: e.length, radius: e.radius, axis: e.axis ?? e.direction, center: e.mid });
      d.neighbors = (rec.topo.edgeFaces[index] ?? []).map((f) => entityName(rec, "face", f).str);
    } else {
      d.center = vertexOf(rec, index);
      d.type = "vertex";
    }
    return d;
  }

  /** Edges tangent-continuous with `edge` (through shared vertices). */
  tangentChain(part: string, edge: number): number[] {
    const rec = this.need(part);
    const t = rec.topo;
    const tangentAt = (e: number, v: number): Vec3 => {
      // which end of the edge touches v: compare positions (explorer order isn't start/end)
      const info = edgeOf(rec, e),
        p = vertexOf(rec, v);
      const d = (a: Vec3) => Math.hypot(a[0] - p[0], a[1] - p[1], a[2] - p[2]);
      return edgeTangent(entityShape(rec, "edge", e), d(info.end) < d(info.start));
    };
    const seen = new Set([edge]);
    const queue = [edge];
    while (queue.length) {
      const e = queue.shift()!;
      for (const v of new Set(t.edgeVertices[e])) {
        const te = tangentAt(e, v);
        for (const n of t.vertexEdges[v] ?? []) {
          if (seen.has(n) || isSeamEdge(rec, n)) continue;
          const tn = tangentAt(n, v);
          const dot = Math.abs(te[0] * tn[0] + te[1] * tn[1] + te[2] * tn[2]);
          if (dot > Math.cos((2 * Math.PI) / 180)) (seen.add(n), queue.push(n));
        }
      }
    }
    return [...seen];
  }

  /** The boundary loop through `edge` on `face` (or, without a face, the adjacent face's larger loop). */
  loopOf(part: string, edge: number, face?: number): number[] {
    const rec = this.need(part);
    let best: number[] | null = null;
    const faces = face !== undefined ? [face] : (rec.topo.edgeFaces[edge] ?? []);
    for (const f of faces) {
      const wires = explore(entityShape(rec, "face", f), "wire").items;
      for (const w of wires) {
        const edges = explore(w, "edge").items.map((e) => rec.topo.edges.indexOf(e)).filter((i) => i >= 0 && !isSeamEdge(rec, i));
        if (edges.includes(edge) && (!best || edges.length > best.length)) best = edges;
      }
    }
    return best ?? [edge];
  }

  /** Ops whose call site is on `line` of `file` (Code mode: cursor → geometry). */
  opsAtLine(part: string, file: string, line: number): string[] {
    const run = this.run(part);
    if (!run) return [];
    return [...new Set(run.ops.filter((o) => o.callSite?.file === file && o.callSite?.line === line && o.type !== "sketch" && o.type !== "path").map((o) => o.id))];
  }

  /** Entities created by an op ("select all from this operation"). */
  fromOperation(part: string, opId: string): { kind: EntityKind; indices: number[] }[] {
    const rec = this.need(part);
    return (["face", "edge"] as EntityKind[]).map((kind) => ({ kind, indices: names(rec, kind).flatMap((n, i) => (n.creator === opId ? [i] : [])) }));
  }

  query(part: string, expr: string, kind: EntityKind = "face"): number[] {
    return select(this.need(part), kind, expr);
  }

  resolve(part: string, target: AnchorTargetRef, tolerance?: number): Resolution {
    return resolveTarget(this.need(part), target, tolerance);
  }

  resolveOne(part: string, kind: EntityKind, candidates: number[], point?: Vec3, neighbors?: string[]) {
    return disambiguate(this.need(part), kind, candidates, point, neighbors);
  }

  indexOfName(part: string, kind: EntityKind, name: string): number[] {
    return nameIndex(this.need(part), kind).get(name) ?? [];
  }

  /** Every face and edge of a part, described (describe_model). */
  describeAll(part: string): { faces: EntityDescription[]; edges: EntityDescription[] } {
    const rec = this.need(part);
    const strip = (d: EntityDescription) => ({ ...d, neighbors: d.kind === "edge" ? d.neighbors : [] });
    return {
      faces: rec.topo.faces.items.map((_, i) => strip(this.describe(part, "face", i))),
      edges: rec.topo.edges.items.flatMap((_, i) => (isSeamEdge(rec, i) ? [] : [strip(this.describe(part, "edge", i))])),
    };
  }

  /** Volume shared by two parts (0 when they don't interfere; contact slivers count as 0, as in `interferences`). */
  interference(a: string, b: string): number {
    const A = this.body(a),
      B = this.body(b);
    try {
      const box = (rec: typeof A) => {
        let bb = this.boxes.get(rec);
        if (!bb) this.boxes.set(rec, bb = scoped(() => boundingBox(rec.shape)));
        return bb;
      };
      const pa = this.poses.get(a) ?? IDENTITY, pb = this.poses.get(b) ?? IDENTITY;
      const ab = worldBox(box(A), pa), bb = worldBox(box(B), pb);
      if ([0, 1, 2].some((k) => ab.min[k] > bb.max[k] || bb.min[k] > ab.max[k])) return 0;
      const rel = composePose(invertPose(pa), pb);
      const key = `${A.key}|${B.key}|${[...rel.r, ...rel.t].join(",")}`;
      const cached = this.volumes.get(key);
      if (cached !== undefined) return cached;
      const r = kBoolean("intersect", this.posedShape(a, A.shape), this.posedShape(b, B.shape));
      r.maker?.delete?.();
      const raw = massProps(r.shape).volume;
      r.shape.delete?.();
      const v = raw > 1e-3 ? raw : 0;
      if (this.volumes.size >= 512) this.volumes.delete(this.volumes.keys().next().value!);
      this.volumes.set(key, v);
      return v;
    } catch {
      return 0;
    }
  }

  /**
   * Minimum distance and closest points (world, posed) per pair, or null when the pair is `within` or
   * farther apart (posed bounding boxes grown by `within` don't meet) or can't be measured.
   */
  distances(pairs: [string, string][], within: number): ({ distance: number; a: Vec3; b: Vec3 } | null)[] {
    const info = new Map<string, { box: Box; shape?: Shape } | null>();
    const get = (p: string) => {
      if (!info.has(p))
        try {
          const rec = this.body(p);
          let bb = this.boxes.get(rec);
          if (!bb) this.boxes.set(rec, (bb = scoped(() => boundingBox(rec.shape))));
          info.set(p, { box: worldBox(bb, this.poses.get(p) ?? IDENTITY) });
        } catch {
          info.set(p, null);
        }
      return info.get(p)!;
    };
    return pairs.map(([a, b]) => {
      const A = get(a), B = get(b);
      if (!A || !B || [0, 1, 2].some((k) => A.box.min[k] - within > B.box.max[k] || B.box.min[k] - within > A.box.max[k])) return null;
      try {
        const d = kDistance((A.shape ??= this.posedShape(a)), (B.shape ??= this.posedShape(b)));
        return d.distance < within ? d : null;
      } catch {
        return null;
      }
    });
  }

  /** Export a part as STEP, STL or 3MF bytes. */
  exportPart(part: string, format: "step" | "stl" | "3mf"): Uint8Array {
    return this.exportParts([part], format);
  }

  /** Export parts together: STEP as one compound, STL as one binary mesh, 3MF as one object per part. Meshes are the fine display tessellation, welded. */
  exportParts(parts: string[], format: "step" | "stl" | "3mf"): Uint8Array {
    if (!parts.length) throw new Error("nothing to export: no parts given");
    if (format === "step") {
      const shapes = parts.map((p) => this.posedShape(p));
      return exportSTEP(shapes.length === 1 ? shapes[0] : compound(shapes));
    }
    const meshes = parts.map((p) => {
      const r = posedMesh(this.meshOf(p), this.poses.get(p));
      return { name: r.name, ...weld(r.mesh!) };
    });
    return format === "3mf" ? export3MF(meshes) : exportSTL(meshes);
  }

  /** Closest point on an entity to `p` (pins follow their geometry across regenerations). */
  closestPoint(part: string, kind: EntityKind, index: number, p: Vec3): Vec3 {
    const rec = this.need(part);
    return pointDistance(entityShape(rec, kind, index), p).b;
  }

  measure(a: { part: string; kind: EntityKind | "part"; index?: number }, b: { part: string; kind: EntityKind | "part"; index?: number }) {
    // where the parts are shown: assembly poses apply, so results are in world coordinates
    const shape = (x: typeof a) => {
      const b = this.body(x.part);
      return this.posedShape(x.part, x.kind === "part" ? b.shape : entityShape(b as OpRecord, x.kind, x.index!));
    };
    return kDistance(shape(a), shape(b));
  }

  /** The shown shape of a part, for B-rep transfer to another engine; null when it has none. */
  shapeOf(part: string): { key: string; brep: string } | null {
    const r = this.shown(part);
    return r ? { key: r.key, brep: writeBrep(r.shape) } : null;
  }

  /** Take another engine's shape for `part` (it regenerates there); regenerating it here drops it. */
  adopt(part: string, key: string, brep: string) {
    this.dropForeign(part);
    this.foreign.set(sourcePart(part), new ForeignShape(key, readBrep(brep)));
  }

  private dropForeign(part: string) {
    const f = this.foreign.get(sourcePart(part));
    if (!f) return;
    this.foreign.delete(sourcePart(part));
    f.dispose();
  }

  /** A part's shape and topology: adopted from another engine, else regenerated here. */
  private body(part: string): { key: string; shape: Shape; topo: Topology } {
    return this.foreign.get(sourcePart(part)) ?? this.need(part);
  }

  /** A part's fine mesh and name, for 3MF export. */
  private meshOf(part: string): { name: string; mesh?: MeshData } {
    const f = this.foreign.get(sourcePart(part));
    if (!f) {
      this.need(part);
      return this.regenerate(part, "fine");
    }
    const name = this.partInfos().find((p) => p.id === sourcePart(part))?.name ?? part;
    return scoped(() => {
      const bb = boundingBox(f.shape);
      const tol = meshTolerances(Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]), "fine");
      return { name, mesh: tessellate(f.shape, f.topo.faces, f.topo.edges, tol.tolerance, tol.angular) };
    });
  }

  private need(part: string): OpRecord {
    const r = this.shown(part);
    if (!r) throw new Error(`part "${part}" has no geometry (it has never regenerated successfully)`);
    return r;
  }

  dispose() {
    this.cache.clear();
    for (const f of this.foreign.values()) f.dispose();
    this.foreign.clear();
  }
}

const STUDIO_FILE = /^studios\/[^/]+\.ts$/;

/** The part id shared params' overrides are stored under. */
export const SHARED = "*";

/** `studios/case.ts` -> `case` (the default part's id, and the prefix of its named parts' ids). */
export const studioStem = (file: string) => file.slice("studios/".length, -".ts".length);

/** A studio's `export const name = "..."`, trimmed; undefined when absent, blank or not a string. */
/**
 * Two faces meeting G1-continuously along edge `e` (a closed edge on one face is a seam, not this),
 * except at a fillet's boundary: that tangent edge is design intent and stays drawn.
 */
function smoothEdge(r: OpRecord, e: number): boolean {
  const f = r.topo.edgeFaces[e] ?? [];
  return f.length === 2 && !f.some((i) => isFilletFace(r, i)) && isSmoothEdge(r.topo.edges.items[e], r.topo.faces.items[f[0]], r.topo.faces.items[f[1]]);
}

/** Whether face `i` was made by a fillet, following it back through the ops that kept or modified it. */
function isFilletFace(r: OpRecord, i: number): boolean {
  for (;;) {
    if (r.type === "fillet" && r.roles.face?.[i]) return true;
    const o = (r.history.face[i] ?? []).filter((x) => x.kind === "face" && x.rel !== "generated").sort((a, b) => a.slot - b.slot || a.index - b.index)[0];
    if (!o) return false;
    r = r.inputs[o.slot];
    i = o.index;
  }
}

function studioName(exports: Record<string, any>): string | undefined {
  const n = exportEntries(exports).find(([k]) => k === "name")?.[1];
  return typeof n === "string" && n.trim() ? n.trim() : undefined;
}

/** The line that exports `key` ("default" for the default export), else 1. */
function exportLine(src: string, key: string): number {
  const k = key.replace(/[$]/g, "\\$");
  const re = key === "default" ? /^\s*export\s+default\b|\bas\s+default\b/m : new RegExp(`^\\s*export\\s+(?:const|let|var|function)\\s+${k}\\b|^\\s*export\\s*\\{[^}]*\\b${k}\\b`, "m");
  const m = re.exec(src);
  return m ? src.slice(0, m.index + m[0].search(/\S/)).split("\n").length : 1;
}

function studioDescription(exports: Record<string, any>): string | undefined {
  const d = exportEntries(exports).find(([k]) => k === "description")?.[1];
  return typeof d === "string" && d.trim() ? d.trim() : undefined;
}

const isPartDef = (v: unknown): v is PartDef => !!v && typeof v === "object" && (v as any).__part === true;
const isAssemblyDef = (v: unknown): v is AssemblyDef => !!v && typeof v === "object" && (v as any).__assembly === true;

/** The first user-code frame of a stack, mapped to its script line. */
function sourceOf(stack: string): SourceRef | undefined {
  for (const f of parseStack(stack)) {
    const m = mapScriptFrame(f);
    if (m && /^(studios|lib)\//.test(m.file)) return { file: m.file, line: m.line, col: m.col };
  }
  return undefined;
}

/** Another engine's part: its shape (read from B-rep) with topology built on first use. */
class ForeignShape {
  private _topo?: Topology;
  constructor(
    readonly key: string,
    readonly shape: Shape,
  ) {}
  get topo() {
    return (this._topo ??= topology(this.shape));
  }
  dispose() {
    if (this._topo) deleteTopology(this._topo);
    this.shape.delete?.();
  }
}

const IDENTITY: PartPose = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
const validPose = (p: PartPose) => !!p && Array.isArray(p.r) && p.r.length === 9 && Array.isArray(p.t) && p.t.length === 3 && [...p.r, ...p.t].every(Number.isFinite);
const applyPose = (p: PartPose, v: Vec3): Vec3 => [
  p.r[0] * v[0] + p.r[1] * v[1] + p.r[2] * v[2] + p.t[0],
  p.r[3] * v[0] + p.r[4] * v[1] + p.r[5] * v[2] + p.t[1],
  p.r[6] * v[0] + p.r[7] * v[1] + p.r[8] * v[2] + p.t[2],
];
function invertPose(p: PartPose): PartPose {
  const r = [p.r[0], p.r[3], p.r[6], p.r[1], p.r[4], p.r[7], p.r[2], p.r[5], p.r[8]];
  const t = applyPose({ r, t: [0, 0, 0] }, p.t);
  return { r, t: [-t[0], -t[1], -t[2]] };
}
function composePose(a: PartPose, b: PartPose): PartPose {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a.r[i * 3] * b.r[j] + a.r[i * 3 + 1] * b.r[3 + j] + a.r[i * 3 + 2] * b.r[6 + j];
  return { r, t: applyPose(a, b.t) };
}
type Box = { min: Vec3; max: Vec3 };
function worldBox(bb: Box, p: PartPose): Box {
  const min: Vec3 = [Infinity, Infinity, Infinity],
    max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; c++) {
    const w = applyPose(p, [c & 1 ? bb.max[0] : bb.min[0], c & 2 ? bb.max[1] : bb.min[1], c & 4 ? bb.max[2] : bb.min[2]]);
    for (let k = 0; k < 3; k++) (min[k] = Math.min(min[k], w[k])), (max[k] = Math.max(max[k], w[k]));
  }
  return { min, max };
}
const boxesOverlap = (a: Box, b: Box) => [0, 1, 2].every((k) => a.min[k] < b.max[k] - 1e-6 && b.min[k] < a.max[k] - 1e-6);
const cloneMesh = (m: MeshData): MeshData => ({ positions: m.positions.slice(), normals: m.normals.slice(), indices: m.indices.slice(), faceRanges: m.faceRanges.slice(), edgePositions: m.edgePositions.slice(), edgeRanges: m.edgeRanges.slice() });

/** A regeneration result with its mesh moved by an assembly pose (3MF export). */
function posedMesh<R extends { mesh?: MeshData }>(r: R, p?: PartPose): R {
  if (!p || !r.mesh) return r;
  const pos = r.mesh.positions.slice();
  for (let i = 0; i < pos.length; i += 3) {
    const w = applyPose(p, [pos[i], pos[i + 1], pos[i + 2]]);
    pos[i] = w[0];
    pos[i + 1] = w[1];
    pos[i + 2] = w[2];
  }
  return { ...r, mesh: { ...r.mesh, positions: pos } };
}

/** Export entries, skipping getters that throw (a re-export of a module that failed). */
function exportEntries(exports: Record<string, any>): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const k of Object.keys(exports)) {
    try {
      out.push([k, exports[k]]);
    } catch {}
  }
  return out;
}

function scriptProblem(e: unknown, part: string, file: string): Problem {
  if (e instanceof ScriptError) {
    const loc = e.line ? `${e.file.split("/").pop()}:${e.line}` : e.file.split("/").pop();
    return { severity: "error", kind: e.kind, message: `${e.message} (${loc})`, part, source: { file: e.file, line: e.line ?? 1, col: e.col } };
  }
  const err = e instanceof Error ? e : new Error(String(e));
  // runtime error at module top level
  const m = /ps:\/\/\/([^:,]+)(?:, <anonymous>)?:(\d+):(\d+)/.exec(err.stack ?? "");
  const mapped = m ? mapScriptFrame({ file: `ps:///${m[1]}`, line: +m[2], col: +m[3] }) : null;
  const loc = mapped ? ` (${mapped.file.split("/").pop()}:${mapped.line})` : "";
  return { severity: "error", kind: "runtime", message: `${err.message}${loc}`, part, source: mapped ? { file: mapped.file, line: mapped.line, col: mapped.col } : { file, line: 1 } };
}

export { compound };

type WeldedMesh = { name: string; positions: Float64Array; indices: Uint32Array };

/** Merge vertices that coincide (the display mesh splits them per face, for flat normals) and drop triangles that collapse: a watertight, indexed mesh on a 0.1 µm grid. */
function weld(m: MeshData): { positions: Float64Array; indices: Uint32Array } {
  const q = 1e4; // 0.1 µm: far under tessellation tolerance, above float32 noise at part scale
  const ids = new Map<string, number>();
  const remap = new Uint32Array(m.positions.length / 3);
  const pos: number[] = [];
  for (let i = 0; i < remap.length; i++) {
    const x = Math.round(m.positions[i * 3] * q), y = Math.round(m.positions[i * 3 + 1] * q), z = Math.round(m.positions[i * 3 + 2] * q);
    const key = `${x},${y},${z}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = pos.length / 3;
      ids.set(key, id);
      pos.push(x / q, y / q, z / q);
    }
    remap[i] = id;
  }
  const idx: number[] = [];
  for (let i = 0; i < m.indices.length; i += 3) {
    const a = remap[m.indices[i]], b = remap[m.indices[i + 1]], c = remap[m.indices[i + 2]];
    if (a !== b && b !== c && a !== c) idx.push(a, b, c);
  }
  return { positions: new Float64Array(pos), indices: new Uint32Array(idx) };
}

/** Binary STL: every part's triangles in one solid, millimeters. */
function exportSTL(meshes: WeldedMesh[]): Uint8Array {
  const count = meshes.reduce((n, m) => n + m.indices.length / 3, 0);
  const out = new Uint8Array(84 + count * 50);
  const dv = new DataView(out.buffer);
  out.set(strToU8("Parasocial binary STL".padEnd(80, " ")));
  dv.setUint32(80, count, true);
  let o = 84;
  for (const { positions: p, indices: t } of meshes) {
    for (let i = 0; i < t.length; i += 3) {
      const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      for (const v of [nx, ny, nz, p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2], p[c], p[c + 1], p[c + 2]]) {
        dv.setFloat32(o, v, true);
        o += 4;
      }
      o += 2; // attribute byte count
    }
  }
  return out;
}

/** Minimal 3MF (core spec): one mesh object per part, millimeters. */
function export3MF(results: WeldedMesh[]): Uint8Array {
  const objects = results.map((m, k) => {
    const v: string[] = [];
    for (let i = 0; i < m.positions.length; i += 3) v.push(`<vertex x="${m.positions[i]}" y="${m.positions[i + 1]}" z="${m.positions[i + 2]}"/>`);
    const t: string[] = [];
    for (let i = 0; i < m.indices.length; i += 3) t.push(`<triangle v1="${m.indices[i]}" v2="${m.indices[i + 1]}" v3="${m.indices[i + 2]}"/>`);
    return `<object id="${k + 1}" name="${m.name.replace(/[<&"]/g, "")}" type="model"><mesh><vertices>${v.join("")}</vertices><triangles>${t.join("")}</triangles></mesh></object>`;
  });
  const items = results.map((_, k) => `<item objectid="${k + 1}"/>`).join("");
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${objects.join("")}</resources><build>${items}</build></model>`;
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`),
    "3D/3dmodel.model": strToU8(model),
  });
}
