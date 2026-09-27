// Operation records: the unit of the element map and of the per-op cache (PLAN §4).
import { topology, collectHistory, deleteTopology, type Built, type EntityHistory, type EntityKind, type Shape, type Topology, type CollectOptions } from "@parasocial/kernel";

export type SourceLoc = { file: string; line: number; col: number; fn?: string };

export type Roles = Partial<Record<EntityKind, (string | undefined)[]>>;

export type OpRecord = {
  /** Stable operation id, e.g. `bracket/base` (tag) or `bracket/extrude1` (auto). */
  id: string;
  type: string;
  tag?: string;
  /** Innermost user call site, source-mapped (`studios/bracket.ts:18:5`). */
  callSite?: SourceLoc;
  /** Helper call chain, outermost first (`mountingHoles()` at bracket.ts:30 -> lib/holes.ts:12). */
  callChain?: SourceLoc[];
  /** Cache key: hash(type, id, params, input keys). */
  key: string;
  inputs: OpRecord[];
  shape: Shape;
  topo: Topology;
  history: EntityHistory;
  /** Role of each output entity created by this op (generated / primitive faces). */
  roles: Roles;
  /** Names assigned directly (sketch segments). */
  explicit?: Roles;
  /** Op parameters, for describe / "created by" display. */
  params?: Record<string, unknown>;
  /** Lazily built names (see names.ts). */
  _names?: Partial<Record<EntityKind, EntityName[]>>;
  /** Refcount-ish liveness for the cache. */
  _gen?: number;
  _released?: boolean;
};

export type EntityName = {
  /** Canonical stable name string. */
  str: string;
  /** Tokens of the entity's own segment, used by selector patterns (not nested sources). */
  head: string[];
  /** Id of the op that gave this entity its own name (for "select all from this operation"). */
  creator: string;
};

export type RecordInit = {
  id: string;
  type: string;
  tag?: string;
  key: string;
  inputs: OpRecord[];
  built: Built;
  /** Topologies of the inputs as seen by the maker (default: each input record's shape topology). */
  inputTopos?: Topology[];
  historyOptions?: CollectOptions;
  /** Precomputed history (e.g. identity for transforms) instead of querying the maker. */
  history?: (topo: Topology) => EntityHistory;
  roles?: (rec: { topo: Topology; history: EntityHistory }) => Roles;
  explicit?: Roles;
  params?: Record<string, unknown>;
  callSite?: SourceLoc;
  callChain?: SourceLoc[];
};

export function createRecord(init: RecordInit): OpRecord {
  const topo = topology(init.built.shape);
  const inputTopos = init.inputTopos ?? init.inputs.map((r) => r.topo);
  const history = init.history ? init.history(topo) : collectHistory(init.built.maker, inputTopos, topo, init.historyOptions);
  const roles = init.roles ? init.roles({ topo, history }) : {};
  init.built.maker?.delete?.();
  return {
    id: init.id,
    type: init.type,
    tag: init.tag,
    key: init.key,
    inputs: init.inputs,
    shape: init.built.shape,
    topo,
    history,
    roles,
    explicit: init.explicit,
    params: init.params,
    callSite: init.callSite,
    callChain: init.callChain,
  };
}

export function releaseRecord(r: OpRecord) {
  if (r._released) return;
  r._released = true;
  deleteTopology(r.topo);
  try {
    r.shape.delete();
  } catch {}
}

export function entityCount(r: OpRecord, kind: EntityKind) {
  return kind === "face" ? r.topo.faces.size : kind === "edge" ? r.topo.edges.size : r.topo.vertices.size;
}

export function entityShape(r: OpRecord, kind: EntityKind, i: number): Shape {
  return (kind === "face" ? r.topo.faces : kind === "edge" ? r.topo.edges : r.topo.vertices).items[i];
}
