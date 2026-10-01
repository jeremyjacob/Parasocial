// The engine side of the bill of materials: regenerate the parts it lists and measure them.
import { exactBox } from "@parasocial/kernel";
import type { Engine } from "./engine";
import { sourcePart } from "./protocol";
import { buildBom, type Bom, type BomOptions, type BomPartInput } from "./bom";

/** Regenerate what the BOM needs and build it. */
export function computeBom(engine: Engine, opts: BomOptions = {}): Bom {
  const infos = engine.partInfos();
  const assemblies = engine.assemblies();
  const asm = opts.assembly !== undefined ? assemblies.find((a) => a.id === opts.assembly) : undefined;
  const ids = asm ? [...new Set(asm.instances.map((i) => sourcePart(i.id)))] : infos.map((p) => p.id);
  const parts: BomPartInput[] = ids.map((id) => {
    const r = engine.regenerate(id, "fine");
    // the display bbox is padded by tolerances: measure the exact geometry for the size column
    const rec = r.empty ? undefined : engine.shown(id);
    let bbox = r.bbox;
    try {
      if (rec) bbox = exactBox(rec.shape);
    } catch {}
    return { part: id, name: r.name, material: r.material, meta: r.meta, bbox, volume: r.mass?.volume };
  });
  return buildBom(parts, infos, assemblies, opts);
}

