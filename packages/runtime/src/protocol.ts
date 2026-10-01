// Messages between the app and the engine (app <-> iframe <-> worker). The app validates every
// message it receives from the engine against these shapes (§5 Sandboxing): the engine is
// untrusted, and mutations are never reachable through this channel.
import type { EntityKind, MeshQuality, Vec3 } from "@parasocial/kernel";
import type { AnchorTargetRef } from "@parasocial/naming";
import type { DocumentState, PartResult, PartInfo, EntityDescription, AssemblyInfo, AssemblyInstance, AssemblyJoint, AssemblyRelation, AssemblySub, ConnectorAt, Interference, PartPose } from "./engine";

export type EngineRequest =
  /** `quiet`: only restore state (a replay into a replacement worker); answers true instead of the part list. */
  | { op: "setDocument"; doc: DocumentState; quiet?: boolean }
  | { op: "setScript"; path: string; content: string | null; quiet?: boolean }
  /** Every part the scripts export (setDocument and setScript also return this). */
  | { op: "parts" }
  /** The parts of a snapshot (another version), from the snapshot engine. */
  | { op: "snapshotParts"; key: string; doc: DocumentState }
  | { op: "setOverrides"; part: string; overrides: Record<string, string | number> }
  | { op: "regenerate"; part: string; quality?: MeshQuality; known?: string }
  /** Parts a change to these script paths can affect (the rest can keep their results). */
  | { op: "affected"; paths: string[] }
  | { op: "names"; part: string }
  | { op: "describe"; part: string; kind: EntityKind; index: number }
  | { op: "fromOperation"; part: string; opId: string }
  | { op: "query"; part: string; expr: string; kind?: EntityKind }
  | { op: "resolve"; part: string; targets: AnchorTargetRef[]; tolerance?: number }
  | { op: "resolveOne"; part: string; kind: EntityKind; candidates: number[]; point?: Vec3; neighbors?: string[] }
  | { op: "indexOfName"; part: string; kind: EntityKind; name: string }
  | { op: "measure"; a: MeasureRef; b: MeasureRef }
  | { op: "check"; part: string }
  | { op: "describeAll"; part: string }
  | { op: "tangentChain"; part: string; edge: number }
  | { op: "loopOf"; part: string; edge: number; face?: number }
  | { op: "opsAtLine"; part: string; file: string; line: number }
  | { op: "interference"; a: string; b: string }
  /** The assemblies the studios export (joints resolved to part ids). */
  | { op: "assemblies" }
  /** Dragged assembly positions (part -> transform from its modeled pose); measure, interference and export use them. */
  | { op: "setPoses"; poses: Record<string, PartPose> }
  /** Where these parts overlap (latest wins: resolves null when superseded). */
  | { op: "interferences"; parts: string[]; ignore?: [string, string][]; poses?: Record<string, PartPose> }
  /** One part (`part`) or several together (`parts`: one STEP/STL compound, one 3MF object each). */
  | { op: "export"; part?: string; parts?: string[]; format: "step" | "stl" | "3mf" }
  | { op: "closestPoint"; part: string; kind: EntityKind; index: number; point: Vec3 }
  /** Regenerate a snapshot (another version) in a separate engine: compare ghosts, viewing old versions. */
  | { op: "regenerateSnapshot"; key: string; doc: DocumentState; part: string }
  /** Engine page internal (multi-worker): a part's shown shape as B-rep, and taking one from another worker. */
  | { op: "shapeOf"; part: string }
  | { op: "adopt"; part: string; key: string; brep: string }
  | { op: "ping" };

export type MeasureRef = { part: string; kind: EntityKind | "part"; index?: number };

export type EngineInfo = {
  threads: number;
  crossOriginIsolated: boolean;
  wasmBytes?: number;
  kernelMs: number;
  build: string;
  /** Engine workers regenerating parts in parallel. */
  workers?: number;
};

/** worker/iframe -> app */
export type EngineMessage =
  | { type: "ready"; info: EngineInfo }
  | { type: "result"; id: number; ok: true; value: unknown }
  | { type: "result"; id: number; ok: false; error: string; timeout?: boolean }
  | { type: "progress"; phase: "kernel" | "regen"; value: number };

export type RequestEnvelope = { id: number; req: EngineRequest };

export type { PartResult, PartInfo, EntityDescription, DocumentState, AssemblyInfo, AssemblyInstance, AssemblyJoint, AssemblyRelation, AssemblySub, ConnectorAt, Interference, PartPose };

/**
 * The part an id's geometry comes from: itself, or an instance's source part. Instance ids are
 * `mechanism/lamp:turret`, `cart/cart:wheel@fl` (a named copy) and `cart/axle@front/cart:wheel@left`
 * (inside an inserted assembly): the part is the last segment, less its copy name. Part ids never
 * contain "/".
 */
export const sourcePart = (id: string) => {
  const last = id.slice(id.lastIndexOf("/") + 1);
  const at = last.indexOf("@");
  return at < 0 ? last : last.slice(0, at);
};

// ---------- validation (app side) ----------

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === "string";

export function validateEngineMessage(m: unknown): EngineMessage | null {
  if (!isObj(m) || !isStr(m.type)) return null;
  if (m.type === "ready") return isObj(m.info) && isNum(m.info.threads) && isNum(m.info.kernelMs) ? (m as EngineMessage) : null;
  if (m.type === "progress") return (m.phase === "kernel" || m.phase === "regen") && isNum(m.value) ? (m as EngineMessage) : null;
  if (m.type === "result") {
    if (!isNum(m.id)) return null;
    if (m.ok === false) return isStr(m.error) ? (m as EngineMessage) : null;
    return m.ok === true ? (m as EngineMessage) : null;
  }
  return null;
}

/** A part list (setDocument / setScript / parts / snapshotParts). */
export function validatePartInfos(v: unknown): PartInfo[] | null {
  if (!Array.isArray(v)) return null;
  for (const p of v) if (!isObj(p) || !isStr(p.id) || !isStr(p.file) || !isStr(p.export) || !isStr(p.name) || !isStr(p.studio)) return null;
  return v as PartInfo[];
}

const isVec3 = (x: unknown) => Array.isArray(x) && x.length === 3 && x.every(isNum);
const RELATION_KINDS = ["gear", "rackPinion", "screw", "linear"];
const JOINT_TYPES = ["fastened", "revolute", "slider", "cylindrical", "planar", "ball"];
const isPose = (x: unknown) => isObj(x) && Array.isArray(x.r) && x.r.length === 9 && x.r.every(isNum) && isVec3(x.t);
const isConnectorAt = (x: unknown) => isObj(x) && isStr(x.connector) && (x.index === undefined || (Number.isInteger(x.index) && (x.index as number) >= 0));

/** The assembly list: instances, joint types, finite frames and limits. */
export function validateAssemblies(v: unknown): AssemblyInfo[] | null {
  if (!Array.isArray(v)) return null;
  for (const a of v) {
    if (!isObj(a) || !isStr(a.id) || !isStr(a.file) || !isStr(a.name) || !isStr(a.studio) || !Array.isArray(a.fixed) || !a.fixed.every(isStr) || !Array.isArray(a.joints) || !Array.isArray(a.problems)) return null;
    if (!Array.isArray(a.instances) || !a.instances.every((i: unknown) => isObj(i) && isStr(i.id) && isStr(i.part) && isStr(i.scope) && (i.name === undefined || isStr(i.name)) && (i.place === undefined || isPose(i.place)))) return null;
    if (!Array.isArray(a.subs) || !a.subs.every((s: unknown) => isObj(s) && isStr(s.id) && isStr(s.parent) && isStr(s.assembly) && (s.place === undefined || isPose(s.place)))) return null;
    for (const p of a.problems) if (!isObj(p) || !isStr(p.message)) return null;
    for (const j of a.joints) {
      if (!isObj(j) || !isStr(j.name) || !JOINT_TYPES.includes(j.type as string) || !isStr(j.a) || !isStr(j.b) || !isStr(j.scope) || typeof j.overlap !== "boolean" || typeof j.named !== "boolean") return null;
      if (!Array.isArray(j.value) || !j.value.every(isNum) || !Array.isArray(j.limits)) return null;
      for (const l of j.limits) if (l !== null && (!isObj(l) || (l.min !== undefined && !isNum(l.min)) || (l.max !== undefined && !isNum(l.max)))) return null;
      const at = j.at;
      if (!isObj(at)) return null;
      if ("frame" in at) {
        const f = at.frame;
        if (!isObj(f) || !isVec3(f.origin) || !isVec3(f.z) || !isVec3(f.x)) return null;
      } else if ("mate" in at) {
        const m = at.mate;
        if (!isObj(m) || !isConnectorAt(m.a) || !isConnectorAt(m.b) || typeof at.flip !== "boolean") return null;
      } else if (!isStr(at.part) || !isConnectorAt(at) || (at.owner !== undefined && !isStr(at.owner))) return null;
    }
    if (!Array.isArray(a.relations)) return null;
    for (const r of a.relations)
      if (!isObj(r) || !RELATION_KINDS.includes(r.kind as string) || !isStr(r.a) || !isStr(r.b) || !isStr(r.scope) || !Number.isInteger(r.ia) || !Number.isInteger(r.ib) || !isNum(r.ratio) || !isNum(r.offset)) return null;
  }
  return v as AssemblyInfo[];
}

const F32 = (x: unknown) => x instanceof Float32Array;
const U32 = (x: unknown) => x instanceof Uint32Array;

function validMesh(m: unknown, faces?: number, edges?: number): boolean {
  if (!isObj(m) || !F32(m.positions) || !F32(m.normals) || !U32(m.indices) || !U32(m.faceRanges) || !F32(m.edgePositions) || !U32(m.edgeRanges)) return false;
  const pos = m.positions as Float32Array,
    idx = m.indices as Uint32Array;
  const nVerts = pos.length / 3;
  if (pos.length % 3 || idx.length % 3) return false;
  for (let i = 0; i < idx.length; i++) if (idx[i] >= nVerts) return false;
  if (faces !== undefined && (m.faceRanges as Uint32Array).length !== faces * 2) return false;
  if (edges !== undefined && (m.edgeRanges as Uint32Array).length !== edges * 2) return false;
  return true;
}

/** Overlaps between parts: part ids, a volume, and a well-formed mesh. */
export function validateInterferences(v: unknown): Interference[] | null {
  if (!Array.isArray(v)) return null;
  for (const x of v) if (!isObj(x) || !isStr(x.a) || !isStr(x.b) || !isNum(x.volume) || (x.mesh !== undefined && !validMesh(x.mesh))) return null;
  return v as Interference[];
}

/** Structural validation of a regeneration result (typed arrays, sizes, problems). */
export function validatePartResult(r: unknown): PartResult | null {
  if (!isObj(r) || !isStr(r.part) || !isStr(r.file) || typeof r.ok !== "boolean" || !Array.isArray(r.problems) || !Array.isArray(r.params)) return null;
  if (!Array.isArray(r.faces) || !Array.isArray(r.edges)) return null;
  for (const p of r.problems) if (!isObj(p) || !isStr(p.message) || (p.severity !== "error" && p.severity !== "warning")) return null;
  if (r.mesh !== undefined && !validMesh(r.mesh, (r.faces as unknown[]).length, (r.edges as unknown[]).length)) return null;
  if (r.connectors !== undefined) {
    if (!isObj(r.connectors)) return null;
    for (const fs of Object.values(r.connectors)) if (!Array.isArray(fs) || !fs.every((f) => isObj(f) && isVec3(f.origin) && isVec3(f.z) && isVec3(f.x))) return null;
  }
  return r as unknown as PartResult;
}
