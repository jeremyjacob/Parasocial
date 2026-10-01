// Manufacturing output tools: bill of materials and 2D drawings. Registered by tools.ts with its
// shared helpers (rate-limited `tool`, the engine pool for the session's configuration, blob storage).
import { z } from "zod";
import { bomToCSV, bomToMarkdown, type Bom } from "@parasocial/runtime/bom";
import type { DocState } from "./docs";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export type OutputToolHelpers = {
  tool: (name: string, description: string, shape: z.ZodRawShape, fn: (args: any) => Promise<ToolResult>, annotations?: Record<string, boolean>) => void;
  document: z.ZodTypeAny;
  load: (document?: string) => Promise<DocState>;
  engine: (d: DocState, ops: { op: string; [k: string]: unknown }[]) => Promise<any[]>;
  /** Store bytes as a blob; returns a signed URL valid for an hour. */
  store: (documentID: string, bytes: Uint8Array, contentType: string) => Promise<string>;
  /** The latest version's number, for the title block. */
  version: (documentID: string) => Promise<number | null>;
};

// compact JSON, like every other tool result
const text = (v: unknown): ToolResult => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v) }] });
const round = (x: number | undefined, d: number) => (x === undefined ? undefined : Math.round(x * 10 ** d) / 10 ** d);

const vec3 = z.array(z.number()).length(3);
const planeName = z.enum(["front", "back", "top", "bottom", "right", "left"]);

export function registerOutputTools(h: OutputToolHelpers) {
  h.tool(
    "bom",
    'Bill of materials: every part of the document once, or with `assembly` (an id like "mechanism") its copies counted per part, subassemblies included. Rows: part number, description, vendor, material, volume, mass, bounding-box size; parts sharing a part number (or standard parts with the same name and vendor) are one row. Declare these with part(name, body, { material, partNumber, description, vendor, standard }). format: json (default), csv or markdown.',
    { document: h.document, assembly: z.string().optional(), format: z.enum(["json", "csv", "markdown"]).optional() },
    async ({ document, assembly, format }) => {
      const d = await h.load(document);
      const [bom] = (await h.engine(d, [{ op: "bom", assembly, documentName: d.name }])) as [Bom];
      if (format === "csv") return text(bomToCSV(bom));
      if (format === "markdown") return text(bomToMarkdown(bom));
      return text({
        ...bom,
        // the document's name is the caller's; density is in the material
        name: assembly ? bom.name : undefined,
        rows: bom.rows.map(({ density: _, ...r }: any) => ({ ...r, volume: round(r.volume, 1), mass: round(r.mass, 2), size: r.size?.map((v: number) => round(v, 3)), instances: r.instances && r.instances.length > 12 ? [...r.instances.slice(0, 12), `… ${r.instances.length - 12} more`] : r.instances })),
        totals: { ...bom.totals, mass: round(bom.totals.mass, 2) },
      });
    },
    { readOnlyHint: true },
  );

  h.tool(
    "drawing",
    'A 2D technical drawing of a part (an instance id draws its part) as SVG or PDF; returns a signed download URL (valid 1 hour). Orthographic views (third-angle unless projection "first"; default views front, top, right, iso) with dashed hidden lines, overall dimensions, hole callouts, scale (default: the largest standard that fits; 2 = 2:1) and a title block. sections: cuts drawn as hatched views A–A, B–B…: { plane: "front" } cuts parallel to the front view through the middle (at: offset along its normal, mm), or { plane: { origin, normal } } with the normal toward the viewer. Uses this session\'s configuration.',
    {
      document: h.document,
      part: z.string(),
      views: z.array(z.enum(["front", "back", "top", "bottom", "right", "left", "iso"])).optional(),
      sections: z.array(z.object({ plane: z.union([planeName, z.object({ origin: vec3, normal: vec3 })]), at: z.number().optional(), label: z.string().max(2).optional() })).max(4).optional(),
      projection: z.enum(["third", "first"]).optional(),
      hidden: z.boolean().optional(),
      sheet: z.enum(["A4", "A3", "A2", "A1"]).optional(),
      scale: z.number().positive().optional(),
      format: z.enum(["svg", "pdf"]).optional(),
    },
    async ({ document, part, views, sections, projection, hidden, sheet, scale, format }) => {
      const d = await h.load(document);
      const version = await h.version(d.id);
      const options = { views, sections, projection, hidden, sheet, scale, format, document: d.name, version: version !== null ? `v${version}` : undefined };
      const [r] = await h.engine(d, [{ op: "drawing", part, options }]);
      const bytes = r.svg !== undefined ? new TextEncoder().encode(r.svg) : new Uint8Array(Buffer.from(r.base64, "base64"));
      const url = await h.store(d.id, bytes, r.svg !== undefined ? "image/svg+xml" : "application/pdf");
      return text({ url, format: r.format, bytes: bytes.length, sheet: r.sheet, scale: r.scaleLabel, views: r.views.map((v: any) => (v.label ? `${v.name} (${v.label}–${v.label})` : v.name)), warnings: r.warnings.length ? r.warnings : undefined });
    },
    { readOnlyHint: true },
  );
}
