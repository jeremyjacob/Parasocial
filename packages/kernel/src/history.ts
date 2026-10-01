// Raw OCCT history -> per-output-entity origins (the input to element maps, PLAN §4).
import { noteKernelFault } from "./oc";
import { listToArray, type EntityKind, type Topology, type ShapeIndex } from "./topo";

export type Relation = "same" | "modified" | "generated";

export type Origin = {
  /** which op input (0 = primary shape, 1.. = tools / profiles) */
  slot: number;
  kind: EntityKind;
  /** entity index in that input's topology */
  index: number;
  rel: Relation;
};

export type EntityHistory = Record<EntityKind, Origin[][]>;

/** Anything with OCCT's BRepBuilderAPI_MakeShape / BRepAlgoAPI history API. */
export type HistoryMaker = {
  Modified(s: any): any;
  Generated(s: any): any;
  IsDeleted(s: any): boolean;
};

const KINDS: EntityKind[] = ["face", "edge", "vertex"];

function idxOf(t: Topology, k: EntityKind): ShapeIndex {
  return k === "face" ? t.faces : k === "edge" ? t.edges : t.vertices;
}

export type CollectOptions = {
  /** Input kinds to query `Generated` for. Default: all. Faces rarely generate. */
  generatedFrom?: EntityKind[];
  /** Skip `Modified`/`IsDeleted` queries (e.g. prism, whose inputs are profiles). */
  noModified?: boolean;
};

/**
 * Run one history query. Some makers throw for shapes they never saw instead of answering
 * "nothing" (BRepOffset_MakeSimpleOffset raises Standard_NoSuchObject from `Generated` for every
 * entity of the parent solid outside the thickened faces); such an entity simply has no history.
 */
function query<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (e) {
    if (noteKernelFault(e)) throw e;
    return fallback;
  }
}

/** Walk Modified/Generated/IsDeleted for every input entity and index the results by output entity. */
export function collectHistory(maker: HistoryMaker | null, inputs: Topology[], output: Topology, opts: CollectOptions = {}): EntityHistory {
  const hist: EntityHistory = {
    face: output.faces.items.map(() => []),
    edge: output.edges.items.map(() => []),
    vertex: output.vertices.items.map(() => []),
  };
  const genKinds = opts.generatedFrom ?? KINDS;
  const push = (outShape: any, o: Origin) => {
    for (const k of KINDS) {
      const i = idxOf(output, k).indexOf(outShape);
      if (i >= 0) {
        const list = hist[k][i];
        if (!list.some((x) => x.slot === o.slot && x.kind === o.kind && x.index === o.index && x.rel === o.rel)) list.push(o);
        return;
      }
    }
  };
  inputs.forEach((topo, slot) => {
    for (const kind of KINDS) {
      const items = idxOf(topo, kind).items;
      for (let index = 0; index < items.length; index++) {
        const s = items[index];
        // unchanged: the very same TShape+location survives in the output
        const same = idxOf(output, kind).indexOf(s);
        if (same >= 0) {
          hist[kind][same].push({ slot, kind, index, rel: "same" });
        } else if (maker && !opts.noModified && !query(() => maker.IsDeleted(s), true)) {
          for (const m of query(() => listToArray(maker.Modified(s)), [] as any[])) {
            push(m, { slot, kind, index, rel: "modified" });
            m.delete();
          }
        }
        if (maker && genKinds.includes(kind)) {
          for (const g of query(() => listToArray(maker.Generated(s)), [] as any[])) {
            push(g, { slot, kind, index, rel: "generated" });
            g.delete();
          }
        }
      }
    }
  });
  return hist;
}

/** History for a pure transform (move/rotate/mirror/copy): output entity i <- input entity i. */
export function identityHistory(output: Topology): EntityHistory {
  return {
    face: output.faces.items.map((_, i) => [{ slot: 0, kind: "face", index: i, rel: "modified" }]),
    edge: output.edges.items.map((_, i) => [{ slot: 0, kind: "edge", index: i, rel: "modified" }]),
    vertex: output.vertices.items.map((_, i) => [{ slot: 0, kind: "vertex", index: i, rel: "modified" }]),
  };
}
