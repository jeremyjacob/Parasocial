// Bill of materials: per document (every part once) or per assembly (copies counted, subassemblies
// included). Rows group by part, or by part number when parts declare one, so a standard part used
// from several studios is one line. `buildBom` is pure (the app builds it from the results it
// already has); `computeBom` (bom-engine.ts) regenerates what it needs. No kernel imports here:
// the app and the MCP server format BOMs without loading geometry code.
import type { Material, PartMeta } from "@parasocial/api/internal";
import type { AssemblyInfo, PartInfo } from "./engine";
import { findAssemblyScope } from "./assembly-scope";

/** What the BOM needs of one part (a subset of `PartResult`). */
export type BomPartInput = {
  part: string;
  name: string;
  material?: Material;
  meta?: PartMeta;
  bbox?: { min: number[]; max: number[] };
  /** mm³ */
  volume?: number;
};

export type BomRow = {
  /** 1-based line number. */
  item: number;
  /** The part id (the first one, when a part number merges several). */
  part: string;
  /** Every part id on this line, when a part number merged several. */
  parts?: string[];
  name: string;
  quantity: number;
  partNumber?: string;
  description?: string;
  vendor?: string;
  standard?: boolean;
  material?: string;
  /** g/cm³ */
  density?: number;
  /** One copy, mm³. */
  volume?: number;
  /** One copy, grams (only when the material's density is known). */
  mass?: number;
  /** One copy's bounding box size, mm (x, y, z in part coordinates). */
  size?: [number, number, number];
  /** The assembly copies counted (instance ids), for an assembly BOM. */
  instances?: string[];
};

export type Bom = {
  /** "document", or the assembly id. */
  scope: string;
  name: string;
  /** An assembly BOM: from `assembly(name, body, { partNumber, description })`. */
  partNumber?: string;
  description?: string;
  rows: BomRow[];
  /** A document BOM: the document's assemblies (pass one as `assembly` to count its copies). */
  assemblies?: { id: string; name: string }[];
  /** Copies of assemblies inserted in this one (nested ones included). */
  subassemblies?: { assembly: string; name: string; partNumber?: string; quantity: number }[];
  totals: {
    /** Lines. */
    items: number;
    /** Copies (sum of quantities). */
    quantity: number;
    /** Grams, over the lines whose mass is known. */
    mass?: number;
    /** Lines without a known mass (no material density). */
    massUnknown: number;
  };
};

export type BomOptions = {
  /** An assembly or subassembly copy id: count its copies, including nested ones. Default: every part once. */
  assembly?: string;
  /** Document name, for the BOM's name when it covers the whole document. */
  documentName?: string;
};

/** Build a BOM from part results (and the assemblies, for an assembly BOM). */
export function buildBom(parts: BomPartInput[], infos: Pick<PartInfo, "id" | "name">[], assemblies: AssemblyInfo[], opts: BomOptions = {}): Bom {
  const byId = new Map(parts.map((p) => [p.part, p]));
  const asm = opts.assembly !== undefined ? findAssemblyScope(assemblies, opts.assembly) : undefined;
  if (opts.assembly !== undefined && !asm) throw new Error(`no assembly "${opts.assembly}"; assemblies: ${assemblies.map((a) => a.id).join(", ") || "none"}`);
  // copies to count: part id -> instance ids
  const copies = new Map<string, string[]>();
  if (asm) for (const i of asm.instances) copies.set(i.part, [...(copies.get(i.part) ?? []), i.id]);
  else for (const p of infos) copies.set(p.id, []);
  const rows: BomRow[] = [];
  const byKey = new Map<string, BomRow>();
  for (const [id, inst] of copies) {
    const r = byId.get(id);
    const name = r?.name ?? infos.find((p) => p.id === id)?.name ?? id;
    const meta = r?.meta;
    const qty = asm ? inst.length : 1;
    // standard parts and part numbers group across studios; everything else is its own line
    const key = meta?.partNumber ? `pn:${meta.partNumber}` : meta?.standard ? `std:${name}\u0000${meta.vendor ?? ""}` : `id:${id}`;
    const have = byKey.get(key);
    if (have) {
      have.quantity += qty;
      have.parts = [...(have.parts ?? [have.part]), id];
      if (asm) have.instances = [...(have.instances ?? []), ...inst];
      continue;
    }
    const mat = r?.material;
    const row: BomRow = {
      item: 0,
      part: id,
      name,
      quantity: qty,
      ...(meta?.partNumber && { partNumber: meta.partNumber }),
      ...(meta?.description && { description: meta.description }),
      ...(meta?.vendor && { vendor: meta.vendor }),
      ...(meta?.standard && { standard: true }),
      ...(mat?.name && { material: mat.name }),
      ...(mat?.density !== undefined && { density: mat.density }),
      ...(r?.volume !== undefined && { volume: r.volume }),
      ...(r?.volume !== undefined && mat?.density !== undefined && { mass: (r.volume / 1000) * mat.density }),
      ...(r?.bbox && { size: [0, 1, 2].map((k) => r.bbox!.max[k] - r.bbox!.min[k]) as [number, number, number] }),
      ...(asm && { instances: inst }),
    };
    byKey.set(key, row);
    rows.push(row);
  }
  rows.forEach((r, i) => (r.item = i + 1));
  const known = rows.filter((r) => r.mass !== undefined);
  // an inserted copy is described by its assembly's own options
  const def = asm && assemblies.find((a) => a.id === asm.definition);
  const bom: Bom = {
    scope: asm ? asm.id : "document",
    name: asm ? asm.name : (opts.documentName ?? "Document"),
    ...(def?.partNumber && { partNumber: def.partNumber }),
    ...(def?.description && { description: def.description }),
    rows,
    totals: {
      items: rows.length,
      quantity: rows.reduce((n, r) => n + r.quantity, 0),
      ...(known.length && { mass: known.reduce((n, r) => n + r.mass! * r.quantity, 0) }),
      massUnknown: rows.length - known.length,
    },
  };
  if (!asm && assemblies.length) bom.assemblies = assemblies.map((a) => ({ id: a.id, name: a.name }));
  if (asm?.subs.length) {
    const count = new Map<string, number>();
    for (const s of asm.subs) count.set(s.assembly, (count.get(s.assembly) ?? 0) + 1);
    bom.subassemblies = [...count].map(([assembly, quantity]) => {
      const a = assemblies.find((a) => a.id === assembly);
      return { assembly, name: a?.name ?? assembly, ...(a?.partNumber && { partNumber: a.partNumber }), quantity };
    });
  }
  return bom;
}

const num = (x: number | undefined, d: number) => (x === undefined ? "" : String(Math.round(x * 10 ** d) / 10 ** d));
const sizeOf = (s?: [number, number, number]) => (s ? s.map((v) => num(v, 2)).join(" × ") : "");

const COLUMNS: [string, (r: BomRow) => string][] = [
  ["Item", (r) => String(r.item)],
  ["Part number", (r) => r.partNumber ?? ""],
  ["Name", (r) => r.name],
  ["Description", (r) => r.description ?? ""],
  ["Qty", (r) => String(r.quantity)],
  ["Material", (r) => r.material ?? ""],
  ["Vendor", (r) => r.vendor ?? ""],
  ["Volume (mm³)", (r) => num(r.volume, 1)],
  ["Mass (g)", (r) => num(r.mass, 2)],
  ["Size (mm)", (r) => sizeOf(r.size)],
  ["Part id", (r) => (r.parts ?? [r.part]).join(" ")],
];

/** CSV (RFC 4180), one line per row, with a header. */
export function bomToCSV(bom: Bom): string {
  const cell = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [COLUMNS.map(([h]) => cell(h)).join(","), ...bom.rows.map((r) => COLUMNS.map(([, f]) => cell(f(r))).join(","))];
  return lines.join("\r\n") + "\r\n";
}

/** A Markdown table with a title and totals. */
export function bomToMarkdown(bom: Bom): string {
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const out = [`# Bill of materials: ${cell(bom.name)}${bom.partNumber ? ` (${cell(bom.partNumber)})` : ""}`, "", ...(bom.description ? [cell(bom.description), ""] : []), `| ${COLUMNS.map(([h]) => h).join(" | ")} |`, `| ${COLUMNS.map(([h]) => (h === "Qty" || h === "Item" || h.startsWith("Volume") || h.startsWith("Mass") ? "---:" : "---")).join(" | ")} |`];
  for (const r of bom.rows) out.push(`| ${COLUMNS.map(([, f]) => cell(f(r))).join(" | ")} |`);
  out.push("", `${bom.totals.items} line${bom.totals.items === 1 ? "" : "s"}, ${bom.totals.quantity} part${bom.totals.quantity === 1 ? "" : "s"}${bom.totals.mass !== undefined ? `, ${num(bom.totals.mass, 1)} g${bom.totals.massUnknown ? ` (${bom.totals.massUnknown} line${bom.totals.massUnknown === 1 ? "" : "s"} without a material density not included)` : ""}` : ""}.`);
  if (bom.subassemblies?.length) out.push("", `Subassemblies: ${bom.subassemblies.map((s) => `${s.quantity}× ${cell(s.name)}${s.partNumber ? ` (${cell(s.partNumber)})` : ""}`).join(", ")}.`);
  return out.join("\n") + "\n";
}
