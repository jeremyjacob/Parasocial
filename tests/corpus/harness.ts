import { loadKernel, massProps, isValid } from "@parasocial/kernel";
import { OpCache, names } from "@parasocial/naming";
import { PartContext, runPart, type PartDef, type PartRun } from "@parasocial/api/internal";

export async function load() {
  await loadKernel();
}

export async function importPart(path: string): Promise<PartDef> {
  return (await import(path)).default;
}

export function regen(def: PartDef, part: string, cache = new OpCache(), overrides: Record<string, string | number> = {}): PartRun {
  cache.begin();
  return runPart(def, new PartContext({ part, file: `parts/${part}.ts`, cache, overrides, isUserFile: (p) => /\/(examples|tests\/corpus)\//.test(p) }));
}

export type Golden = { volume: number; area: number; faces: number; edges: number; vertices: number; valid: boolean; faceNames: string[] };

export function summarize(r: PartRun): Golden {
  const rec = r.record!;
  const m = massProps(rec.shape);
  return {
    volume: round(m.volume),
    area: round(m.area),
    faces: rec.topo.faces.size,
    edges: rec.topo.edges.size,
    vertices: rec.topo.vertices.size,
    valid: isValid(rec.shape),
    faceNames: names(rec, "face").map((n) => n.str).sort(),
  };
}

const round = (x: number) => Math.round(x * 1e4) / 1e4;
