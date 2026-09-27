// Corpus harness: runs parts through the real engine (loader, sandbox, provenance), not a direct import.
import { loadKernel, massProps, isValid } from "@parasocial/kernel";
import { names, type OpRecord } from "@parasocial/naming";
import { Engine, type PartResult } from "@parasocial/runtime";
import { Glob } from "bun";
import { join, dirname, basename } from "node:path";
import { readFileSync } from "node:fs";

export async function load() {
  await loadKernel();
}

/** An engine loaded with the document that contains `file` (a studios/*.ts path under examples/ or tests/corpus/), and the parts that file exports. */
export function engineFor(file: string): { engine: Engine; part: string; parts: { id: string; export: string }[] } {
  const docRoot = dirname(dirname(file));
  const scripts: Record<string, string> = {};
  for (const f of new Glob("{studios,lib}/**/*.ts").scanSync(docRoot)) scripts[f] = readFileSync(join(docRoot, f), "utf8");
  const engine = new Engine();
  engine.setDocument({ scripts });
  const parts = engine.partInfos().filter((p) => p.file === `studios/${basename(file)}`);
  return { engine, part: basename(file, ".ts"), parts };
}

export function regen(e: Engine, part: string, overrides: Record<string, string | number> = {}): PartResult & { record: OpRecord } {
  e.setOverrides(part, overrides);
  const r = e.regenerate(part);
  return Object.assign(r, { record: e.shown(part)! });
}

export type Golden = { volume: number; area: number; faces: number; edges: number; vertices: number; valid: boolean; faceNames: string[] };

export function summarize(rec: OpRecord): Golden {
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
