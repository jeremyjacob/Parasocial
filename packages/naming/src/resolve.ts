// Note anchor resolution (PLAN §6): stable name / query first, then the nearest entity of
// the same kind to the stored point within a tolerance, else orphaned. Never guesses beyond that.
import { pointDistance, type EntityKind, type Vec3 } from "@parasocial/kernel";
import { entityCount, entityShape, type OpRecord } from "./record";
import { nameIndex } from "./names";
import { select } from "./query";
import { pointOn, dist } from "./info";

export type AnchorTargetRef = {
  kind: EntityKind | "part" | "point";
  name: string;
  query?: string;
  point: Vec3;
  normal?: Vec3;
};

export type Resolution =
  | { status: "name" | "query"; indices: number[] }
  | { status: "nearest"; indices: number[]; distance: number }
  | { status: "orphaned"; indices: [] };

export function resolveTarget(r: OpRecord, t: AnchorTargetRef, tolerance = 0.5): Resolution {
  if (t.kind === "part" || t.kind === "point") return { status: "name", indices: [] };
  const byName = nameIndex(r, t.kind).get(t.name);
  if (byName?.length) return { status: "name", indices: byName };
  if (t.query) {
    try {
      const q = select(r, t.kind, t.query);
      if (q.length) return { status: "query", indices: q };
    } catch {}
  }
  const n = nearest(r, t.kind, t.point, tolerance);
  if (n) return { status: "nearest", indices: [n.index], distance: n.distance };
  return { status: "orphaned", indices: [] };
}

/** Nearest entity of `kind` to `p` within `tolerance` (exact B-rep distance, prefiltered by distance to a point on each). */
export function nearest(r: OpRecord, kind: EntityKind, p: Vec3, tolerance: number): { index: number; distance: number } | null {
  const n = entityCount(r, kind);
  const order = [...Array(n).keys()].map((i) => ({ i, d: dist(pointOn(r, kind, i), p) })).sort((a, b) => a.d - b.d);
  let best: { index: number; distance: number } | null = null;
  for (const { i } of order.slice(0, 24)) {
    const d = pointDistance(entityShape(r, kind, i), p).distance;
    if (d <= tolerance && (!best || d < best.distance)) best = { index: i, distance: d };
  }
  return best;
}

/**
 * When a name resolves to several descendants (a split) but one is wanted: prefer the one
 * adjacent to the most `neighbors` (named entities that were next to it), then the closest to `p`.
 */
export function disambiguate(r: OpRecord, kind: EntityKind, candidates: number[], p?: Vec3, neighbors: string[] = []): number {
  if (candidates.length <= 1) return candidates[0];
  let scored = candidates.map((i) => ({ i, adj: neighbors.length ? adjacencyScore(r, kind, i, neighbors) : 0, d: p ? pointDistance(entityShape(r, kind, i), p).distance : 0 }));
  const maxAdj = Math.max(...scored.map((s) => s.adj));
  scored = scored.filter((s) => s.adj === maxAdj);
  scored.sort((a, b) => a.d - b.d);
  return scored[0].i;
}

function adjacencyScore(r: OpRecord, kind: EntityKind, i: number, neighbors: string[]): number {
  if (kind !== "face") return 0;
  const idx = nameIndex(r, "face");
  const want = new Set(neighbors.flatMap((n) => idx.get(n) ?? []));
  let s = 0;
  for (const e of r.topo.faceEdges[i] ?? []) for (const f of r.topo.edgeFaces[e] ?? []) if (f !== i && want.has(f)) s++;
  return s;
}
