// Messages between the app and the engine (app <-> iframe <-> worker). The app validates every
// message it receives from the engine against these shapes (§5 Sandboxing): the engine is
// untrusted, and mutations are never reachable through this channel.
import type { EntityKind, MeshQuality, Vec3 } from "@parasocial/kernel";
import type { AnchorTargetRef } from "@parasocial/naming";
import type { DocumentState, PartResult, EntityDescription } from "./engine";

export type EngineRequest =
  | { op: "setDocument"; doc: DocumentState }
  | { op: "setScript"; path: string; content: string | null }
  | { op: "setOverrides"; part: string; overrides: Record<string, string | number> }
  | { op: "regenerate"; part: string; quality?: MeshQuality }
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
  | { op: "interference"; a: string; b: string }
  | { op: "export"; part: string; format: "step" | "stl" | "3mf" }
  | { op: "closestPoint"; part: string; kind: EntityKind; index: number; point: Vec3 }
  /** Regenerate a snapshot (another version) in a separate engine: compare ghosts, viewing old versions. */
  | { op: "regenerateSnapshot"; key: string; doc: DocumentState; part: string }
  | { op: "ping" };

export type MeasureRef = { part: string; kind: EntityKind | "part"; index?: number };

export type EngineInfo = {
  threads: number;
  crossOriginIsolated: boolean;
  wasmBytes?: number;
  kernelMs: number;
  build: string;
};

/** worker/iframe -> app */
export type EngineMessage =
  | { type: "ready"; info: EngineInfo }
  | { type: "result"; id: number; ok: true; value: unknown }
  | { type: "result"; id: number; ok: false; error: string; timeout?: boolean }
  | { type: "progress"; phase: "kernel" | "regen"; value: number };

export type RequestEnvelope = { id: number; req: EngineRequest };

export type { PartResult, EntityDescription, DocumentState };

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

const F32 = (x: unknown) => x instanceof Float32Array;
const U32 = (x: unknown) => x instanceof Uint32Array;

/** Structural validation of a regeneration result (typed arrays, sizes, problems). */
export function validatePartResult(r: unknown): PartResult | null {
  if (!isObj(r) || !isStr(r.part) || !isStr(r.file) || typeof r.ok !== "boolean" || !Array.isArray(r.problems) || !Array.isArray(r.params)) return null;
  if (!Array.isArray(r.faces) || !Array.isArray(r.edges)) return null;
  for (const p of r.problems) if (!isObj(p) || !isStr(p.message) || (p.severity !== "error" && p.severity !== "warning")) return null;
  if (r.mesh !== undefined) {
    const m = r.mesh as Record<string, unknown>;
    if (!isObj(m) || !F32(m.positions) || !F32(m.normals) || !U32(m.indices) || !U32(m.faceRanges) || !F32(m.edgePositions) || !U32(m.edgeRanges)) return null;
    const pos = m.positions as Float32Array,
      idx = m.indices as Uint32Array;
    const nVerts = pos.length / 3;
    if (pos.length % 3 || idx.length % 3) return null;
    for (let i = 0; i < idx.length; i++) if (idx[i] >= nVerts) return null;
    if ((m.faceRanges as Uint32Array).length !== (r.faces as unknown[]).length * 2) return null;
    if ((m.edgeRanges as Uint32Array).length !== (r.edges as unknown[]).length * 2) return null;
  }
  return r as unknown as PartResult;
}
