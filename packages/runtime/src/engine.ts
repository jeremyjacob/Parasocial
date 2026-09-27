// The engine: holds a document's scripts + overrides, regenerates parts through the per-op
// cache, and answers geometry queries. Environment-agnostic: runs in the browser worker, in
// the headless engine pool, and under bun test.
import { boundingBox, massProps, isValid, pointDistance, meshTolerances, tessellate, scoped, type EntityKind, type MeshData, type MeshQuality, type Vec3, distance as kDistance, compound } from "@parasocial/kernel";
import { OpCache, entityName, names, nameIndex, select, isSeamEdge, resolveTarget, disambiguate, faceOf, edgeOf, vertexOf, lineage, entityShape, type OpRecord, type AnchorTargetRef, type Resolution } from "@parasocial/naming";
import * as api from "@parasocial/api";
import { PartContext, runPart, type PartDef, type PartRun, type Problem, type ParamDecl, type ColorSpec, type Material, SI_DEFAULT, UNITS } from "@parasocial/api/internal";
import { loadModule, mapScriptFrame, ScriptError } from "./loader";

export type DocumentState = {
  scripts: Record<string, string>;
  /** part id -> param name -> expression/value, for the active configuration */
  overrides?: Record<string, Record<string, string | number>>;
  units?: { length: string; angle: string };
};

export type FaceMeta = { surface: string; area: number; center: Vec3; normal: Vec3; radius?: number; axis?: Vec3 };
export type EdgeMeta = { curve: string; length: number; mid: Vec3; radius?: number; direction?: Vec3; center?: Vec3; seam?: boolean };

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
  material?: Material;
  quality: MeshQuality;
  mesh?: MeshData;
  faces: FaceMeta[];
  edges: EdgeMeta[];
  vertices: Vec3[];
  /** face index -> bounding edge indices (for face outlines) */
  faceEdges: number[][];
  bbox?: { min: Vec3; max: Vec3 };
  mass?: { volume: number; area: number; mass: number; centroid: Vec3 };
  timings: { total: number; script: number; ops: number; mesh: number; cacheHits: number; cacheMisses: number };
  /** hash of the final op (derived-data cache key component) */
  key?: string;
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
  private seed = 1;

  setDocument(doc: DocumentState) {
    this.scripts = new Map(Object.entries(doc.scripts));
    this.overrides = doc.overrides ?? {};
    if (doc.units) this.units = { length: UNITS[doc.units.length] ?? SI_DEFAULT.length, angle: UNITS[doc.units.angle] ?? SI_DEFAULT.angle };
  }
  setScript(path: string, content: string | null) {
    if (content === null) this.scripts.delete(path);
    else this.scripts.set(path, content);
  }
  setOverrides(part: string, o: Record<string, string | number>) {
    this.overrides[part] = o;
  }
  getScripts() {
    return Object.fromEntries(this.scripts);
  }

  /** Part ids in stable order (parts/*.ts, sorted). */
  parts(): string[] {
    return [...this.scripts.keys()]
      .filter((p) => /^parts\/[^/]+\.ts$/.test(p))
      .sort()
      .map((p) => p.slice(6, -3));
  }

  regenerate(part: string, quality: MeshQuality = "fine"): PartResult {
    const t0 = performance.now();
    const file = `parts/${part}.ts`;
    const partIndex = this.parts().indexOf(part);
    this.cache.begin();
    let def: PartDef | undefined;
    let problems: Problem[] = [];
    let run: PartRun | undefined;
    const tScript = performance.now();
    try {
      if (!this.scripts.has(file)) throw new ScriptError(`no script at ${file}`, file);
      const mod = loadModule(file, { scripts: this.scripts, api: API_MODULE, seed: this.seed });
      def = mod.default;
      if (!def || (def as any).__part !== true) throw new ScriptError(`${file} must \`export default part("Name", () => ...)\``, file, undefined, undefined, "runtime");
    } catch (e) {
      problems.push(scriptProblem(e, part, file));
    }
    if (def) {
      const ctx = new PartContext({ part, file, cache: this.cache, overrides: this.overrides[part] ?? {}, units: this.units, partIndex, mapFrame: mapScriptFrame, isUserFile: (f) => /^(parts|lib)\//.test(f) });
      run = runPart(def, ctx);
      problems = run.problems;
      this.runs.set(part, run);
    }
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
      name: run?.name ?? def?.name ?? part,
      ok: !!run?.ok && !problems.some((p) => p.severity === "error"),
      partial: !run?.ok,
      empty: !rec,
      problems,
      params: run?.params ?? [],
      color: run?.color,
      material: run?.material,
      quality,
      faces: [],
      edges: [],
      vertices: [],
      faceEdges: [],
      timings: { total: 0, script: scriptMs, ops: run?.timings.ops ?? 0, mesh: 0, cacheHits: run?.timings.cacheHits ?? 0, cacheMisses: run?.timings.cacheMisses ?? 0 },
      key: rec?.key,
    };
    if (rec) {
      const tm = performance.now();
      scoped(() => {
        const bb = boundingBox(rec!.shape);
        result.bbox = bb;
        const diag = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]);
        const tol = meshTolerances(diag, quality);
        result.mesh = tessellate(rec!.shape, rec!.topo.faces, rec!.topo.edges, tol.tolerance, tol.angular);
      });
      result.timings.mesh = performance.now() - tm;
      result.faces = rec.topo.faces.items.map((_, i) => {
        const f = faceOf(rec!, i);
        return { surface: f.surface, area: f.area, center: f.center, normal: f.normal, radius: f.radius, axis: f.axis };
      });
      result.edges = rec.topo.edges.items.map((_, i) => {
        const e = edgeOf(rec!, i);
        return { curve: e.curve, length: e.length, mid: e.mid, radius: e.radius, direction: e.direction, center: e.center, seam: isSeamEdge(rec!, i) || undefined };
      });
      result.vertices = rec.topo.vertices.items.map((_, i) => vertexOf(rec!, i));
      result.faceEdges = rec.topo.faceEdges.map((l) => [...l]);
      if (quality === "fine") {
        const m = massProps(rec.shape);
        result.mass = { volume: m.volume, area: m.area, centroid: m.centroid, mass: (m.volume / 1000) * (run?.material?.density ?? 1) };
      }
    }
    result.timings.total = performance.now() - t0;
    return result;
  }

  /** Validity check (BRepCheck) as warnings; slow-ish, so run after the mesh is on screen. */
  check(part: string): Problem[] {
    const rec = this.shown(part);
    if (!rec) return [];
    return isValid(rec.shape) ? [] : [{ severity: "warning", kind: "invalid", message: `${part} geometry is not valid (BRepCheck); a boolean or fillet may have produced bad topology`, part }];
  }

  /** The record currently shown for a part (latest, or last good). */
  shown(part: string): OpRecord | undefined {
    const r = this.runs.get(part);
    return r?.record ?? this.lastGood.get(part);
  }

  run(part: string) {
    return this.runs.get(part);
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

  /** Closest point on an entity to `p` (pins follow their geometry across regenerations). */
  closestPoint(part: string, kind: EntityKind, index: number, p: Vec3): Vec3 {
    const rec = this.need(part);
    return pointDistance(entityShape(rec, kind, index), p).b;
  }

  measure(a: { part: string; kind: EntityKind | "part"; index?: number }, b: { part: string; kind: EntityKind | "part"; index?: number }) {
    const shape = (x: typeof a) => {
      const rec = this.need(x.part);
      return x.kind === "part" ? rec.shape : entityShape(rec, x.kind, x.index!);
    };
    return kDistance(shape(a), shape(b));
  }

  private need(part: string): OpRecord {
    const r = this.shown(part);
    if (!r) throw new Error(`part "${part}" has no geometry (it has never regenerated successfully)`);
    return r;
  }

  dispose() {
    this.cache.clear();
  }
}

function scriptProblem(e: unknown, part: string, file: string): Problem {
  if (e instanceof ScriptError) {
    const loc = e.line ? `${e.file.split("/").pop()}:${e.line}` : e.file.split("/").pop();
    return { severity: "error", kind: e.kind, message: `${e.message} (${loc})`, part, source: { file: e.file, line: e.line ?? 1, col: e.col } };
  }
  const err = e instanceof Error ? e : new Error(String(e));
  // runtime error at module top level
  const m = /ps:\/\/\/([^:]+):(\d+):(\d+)/.exec(err.stack ?? "");
  const mapped = m ? mapScriptFrame({ file: `ps:///${m[1]}`, line: +m[2], col: +m[3] }) : null;
  const loc = mapped ? ` (${mapped.file.split("/").pop()}:${mapped.line})` : "";
  return { severity: "error", kind: "runtime", message: `${err.message}${loc}`, part, source: mapped ? { file: mapped.file, line: mapped.line, col: mapped.col } : { file, line: 1 } };
}

export { compound };
