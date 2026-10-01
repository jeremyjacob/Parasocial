// 2D technical drawings of a part: orthographic views (third angle by default) and an isometric,
// with hidden lines (OCCT hidden-line removal), section views (cut, hatched, labelled A–A),
// overall dimensions, hole callouts, scale and a title block. Output is SVG or PDF.
import { projectHLR, sectionCut, faceLoops, toView, exactBox, edgeInfo, faceInfo, explore, scoped, type ViewFrame, type Vec3, type Shape } from "@parasocial/kernel";
import type { Engine } from "./engine";
import { sourcePart } from "./protocol";
import { sheetToSVG, sheetToPDF, textWidth, type P2, type Prim, type Sheet, type LineStyle } from "./sheet";

export type ViewName = "front" | "back" | "top" | "bottom" | "right" | "left" | "iso";

/**
 * A section view: the part cut by a plane, looked at square to it. `plane` names the view it's
 * parallel to ("front" cuts parallel to the front view and is looked at like it), or gives the
 * plane: `origin` on it, `normal` pointing at the viewer (the material on that side is removed).
 */
export type SectionSpec = {
  plane: "front" | "back" | "top" | "bottom" | "right" | "left" | { origin: Vec3; normal: Vec3 };
  /** Where a named plane cuts, along its normal axis (mm, model coordinates). Default: through the middle of the part. */
  at?: number;
  /** Letter (default A, B, … in order). */
  label?: string;
};

export type DrawingOptions = {
  /** Views to draw (default front, top, right, iso). */
  views?: ViewName[];
  /** Where views go relative to the front view (default third angle). */
  projection?: "third" | "first";
  sections?: SectionSpec[];
  /** Dashed hidden lines in the orthographic views (default true). */
  hidden?: boolean;
  /** Overall dimensions and hole callouts (default true). */
  dimensions?: boolean;
  /** Paper size, landscape (default: A4, A3 when the part would be drawn smaller than 1:1 on A4 but not on A3). */
  sheet?: "A4" | "A3" | "A2" | "A1";
  /** Drawing scale as paper/model (2 = 2:1, 0.5 = 1:2). Default: the largest standard scale that fits. */
  scale?: number;
  format?: "svg" | "pdf";
  /** Title block fields. */
  title?: string;
  document?: string;
  version?: string;
  date?: string;
  author?: string;
};

export type DrawingResult = {
  format: "svg" | "pdf";
  /** SVG text, or PDF bytes. */
  svg?: string;
  pdf?: Uint8Array;
  sheet: string;
  scale: number;
  /** "2:1", "1:5". */
  scaleLabel: string;
  /** Each view: its name, section letter, and where it sits on the sheet (center and size, paper mm, y down). */
  views: { name: string; label?: string; at: [number, number]; size: [number, number] }[];
  warnings: string[];
};

const VIEWS: Record<ViewName, ViewFrame> = {
  front: { dir: [0, -1, 0], x: [1, 0, 0] },
  back: { dir: [0, 1, 0], x: [-1, 0, 0] },
  top: { dir: [0, 0, 1], x: [1, 0, 0] },
  bottom: { dir: [0, 0, -1], x: [1, 0, 0] },
  right: { dir: [1, 0, 0], x: [0, 1, 0] },
  left: { dir: [-1, 0, 0], x: [0, -1, 0] },
  iso: { dir: [1 / Math.sqrt(3), -1 / Math.sqrt(3), 1 / Math.sqrt(3)], x: [Math.SQRT1_2, Math.SQRT1_2, 0] },
};
/** Grid cell of each orthographic view relative to the front view (column, row; row grows downward). */
const PLACE: Record<"third" | "first", Partial<Record<ViewName, [number, number]>>> = {
  third: { front: [0, 0], top: [0, -1], bottom: [0, 1], right: [1, 0], left: [-1, 0], back: [2, 0] },
  first: { front: [0, 0], top: [0, 1], bottom: [0, -1], right: [-1, 0], left: [1, 0], back: [-2, 0] },
};
const SHEETS: Record<string, [number, number]> = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594] };
/** Standard scales, largest first (ISO 5455). */
const SCALES = [50, 20, 10, 5, 2, 1, 1 / 2, 1 / 5, 1 / 10, 1 / 20, 1 / 50, 1 / 100, 1 / 200, 1 / 500, 1 / 1000];

const MARGIN = 10;
const TITLE_H = 32;
const GAP = 18; // paper mm between views: room for dimensions
const PAD = 14; // paper mm around the views, inside the frame
const DIM_OFFSET = 8;
const TEXT = 3.5;

type View = {
  name: string;
  /** Section label ("A"), for section views. */
  label?: string;
  frame: ViewFrame;
  ortho: boolean;
  visible: P2[][];
  tangent: P2[][];
  hidden: P2[][];
  hatch: P2[][][];
  /** 2D extents in model units. */
  min: P2;
  max: P2;
  cell: [number, number];
  /** Paper position of the model-2D center, once laid out. */
  at?: P2;
};

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crossV = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** A number for a dimension: up to two decimals, no trailing zeros. */
export const fmtMM = (v: number) => String(Math.round(v * 100) / 100);
export const scaleLabel = (s: number) => (s >= 1 ? `${fmtMM(s)}:1` : `1:${fmtMM(1 / s)}`);

/** Frame of a section plane (view direction = its normal), with x chosen like the named views. */
function sectionFrame(normal: Vec3): ViewFrame {
  const dir = unit(normal);
  let x = crossV([0, 0, 1], dir);
  if (Math.hypot(...x) < 1e-6) x = [1, 0, 0];
  return { dir, x: unit(x) };
}

/** Drop hidden polylines lying on visible ones (an edge seen and hidden behind itself). */
function dropCovered(hidden: P2[][], visible: P2[][], eps: number): P2[][] {
  const segs: [P2, P2][] = [];
  for (const l of visible) for (let i = 1; i < l.length; i++) segs.push([l[i - 1], l[i]]);
  const near = (p: P2) =>
    segs.some(([a, b]) => {
      if (p[0] < Math.min(a[0], b[0]) - eps || p[0] > Math.max(a[0], b[0]) + eps || p[1] < Math.min(a[1], b[1]) - eps || p[1] > Math.max(a[1], b[1]) + eps) return false;
      const dx = b[0] - a[0],
        dy = b[1] - a[1];
      const L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
      return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]) <= eps;
    });
  return hidden.filter((l) => {
    const pts = [...l];
    for (let i = 1; i < l.length; i++) pts.push([(l[i - 1][0] + l[i][0]) / 2, (l[i - 1][1] + l[i][1]) / 2]);
    return !pts.every(near);
  });
}

function extents(lines: P2[][]): { min: P2; max: P2 } {
  const min: P2 = [Infinity, Infinity],
    max: P2 = [-Infinity, -Infinity];
  for (const l of lines)
    for (const p of l) {
      min[0] = Math.min(min[0], p[0]);
      min[1] = Math.min(min[1], p[1]);
      max[0] = Math.max(max[0], p[0]);
      max[1] = Math.max(max[1], p[1]);
    }
  if (!Number.isFinite(min[0])) return { min: [0, 0], max: [0, 0] };
  return { min, max };
}

/** Column widths and row heights (model units) of views laid out on a grid, and the scale that fits a sheet. */
function gridOf(views: View[]) {
  const colIds = [...new Set(views.map((v) => v.cell[0]))].sort((a, b) => a - b);
  const rowIds = [...new Set(views.map((v) => v.cell[1]))].sort((a, b) => a - b);
  const colW = colIds.map((c) => Math.max(...views.filter((v) => v.cell[0] === c).map((v) => v.max[0] - v.min[0])));
  const rowH = rowIds.map((r) => Math.max(...views.filter((v) => v.cell[1] === r).map((v) => v.max[1] - v.min[1])));
  const sumW = colW.reduce((a, b) => a + b, 0) || 1,
    sumH = rowH.reduce((a, b) => a + b, 0) || 1;
  const fit = (sheet: string) => {
    const [W, H] = SHEETS[sheet];
    const aw = W - 2 * MARGIN - 2 * PAD - GAP * (colIds.length - 1);
    const ah = H - 2 * MARGIN - TITLE_H - 2 * PAD - GAP * (rowIds.length - 1);
    return Math.min(aw / sumW, ah / sumH);
  };
  return { colIds, rowIds, colW, rowH, sumW, sumH, fit };
}

/** Draw a part. Regenerates it if the engine hasn't yet. */
export function drawPart(engine: Engine, part: string, opts: DrawingOptions = {}): DrawingResult {
  const src = sourcePart(part);
  const ids = engine.parts();
  if (!ids.includes(src)) throw new Error(`no part "${part}"; parts: ${ids.join(", ") || "none"}`);
  if (!engine.run(src)) engine.regenerate(src, "coarse");
  const run = engine.run(src);
  const rec = engine.shown(src);
  if (!rec) throw new Error(`part "${part}" has no geometry to draw (it has never regenerated successfully)`);
  const warnings: string[] = [];
  if (!run?.ok) warnings.push(`${part} failed to regenerate; drawing its last good geometry`);
  const info = engine.partInfos().find((p) => p.id === src);
  return scoped(() => drawShape(rec.shape, {
    ...opts,
    title: opts.title ?? run?.name ?? info?.name ?? part,
    meta: { part: src, material: run?.material?.name, partNumber: run?.meta?.partNumber, description: run?.meta?.description },
    warnings,
  }));
}

type ShapeInput = DrawingOptions & { meta?: { part?: string; material?: string; partNumber?: string; description?: string }; warnings?: string[] };

/** Draw any solid (the engine-free core of `drawPart`). */
export function drawShape(shape: Shape, opts: ShapeInput = {}): DrawingResult {
  const warnings = opts.warnings ?? [];
  const projection = opts.projection ?? "third";
  const names: ViewName[] = [...new Set(opts.views ?? (["front", "top", "right", "iso"] as ViewName[]))];
  for (const n of names) if (!(n in VIEWS)) throw new Error(`unknown view "${n}"; use ${Object.keys(VIEWS).join(", ")}`);
  const showHidden = opts.hidden !== false;
  const box = exactBox(shape);
  const diag = Math.hypot(...sub(box.max, box.min)) || 1;
  const eps = diag / 1500;

  const views: View[] = [];
  const place = PLACE[projection];
  for (const n of names) {
    if (n === "iso") continue;
    const frame = VIEWS[n];
    const p = projectHLR(shape, frame, { hidden: showHidden });
    const hidden = dropCovered(p.hidden, [...p.visible, ...p.tangent], eps);
    const e = extents([...p.visible, ...p.tangent, ...hidden]);
    views.push({ name: n, frame, ortho: true, visible: p.visible, tangent: p.tangent, hidden, hatch: [], ...e, cell: place[n]! });
  }

  // sections: cut, project, hatch the cut faces
  const sections: View[] = [];
  const cuts: { label: string; origin: Vec3; normal: Vec3 }[] = [];
  const center: Vec3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
  (opts.sections ?? []).forEach((s, i) => {
    const label = (s.label ?? String.fromCharCode(65 + i)).toUpperCase();
    let origin: Vec3, normal: Vec3;
    if (typeof s.plane === "string") {
      if (!(s.plane in VIEWS) || s.plane === ("iso" as string)) throw new Error(`section plane "${s.plane}": use front, back, top, bottom, right, left or { origin, normal }`);
      normal = VIEWS[s.plane].dir;
      const axis = normal.findIndex((c) => Math.abs(c) > 0.5);
      origin = [...center] as Vec3;
      if (s.at !== undefined) origin[axis] = s.at;
    } else {
      origin = s.plane.origin;
      normal = unit(s.plane.normal);
      if (!origin || !normal || [...origin, ...normal].some((v) => !Number.isFinite(v)) || Math.hypot(...s.plane.normal) < 1e-9) throw new Error(`section ${label}: plane needs a finite origin and a non-zero normal`);
    }
    const cut = sectionCut(shape, origin, normal);
    if (!cut || !cut.faces.length) {
      warnings.push(`section ${label}–${label} misses the part (plane through [${origin.map(fmtMM).join(", ")}], normal [${normal.map(fmtMM).join(", ")}])`);
      cut?.faces.forEach((f) => f.delete?.());
      cut?.shape.delete?.();
      return;
    }
    const frame = sectionFrame(normal);
    const p = projectHLR(cut.shape, frame, { hidden: false });
    const hatch = cut.faces.map((f) => faceLoops(f, eps / 2).map((l) => l.map((q) => toView(frame, q))));
    cut.faces.forEach((f) => f.delete?.());
    cut.shape.delete?.();
    const e = extents([...p.visible, ...p.tangent, ...hatch.flat()]);
    sections.push({ name: `section ${label}`, label, frame, ortho: false, visible: p.visible, tangent: p.tangent, hidden: [], hatch, ...e, cell: [0, 0] });
    cuts.push({ label, origin, normal });
  });

  // the iso and the sections go in free cells: wherever the views come out biggest (ties: iso top
  // right, sections right of the front view)
  const extras: View[] = [];
  if (names.includes("iso")) {
    const frame = VIEWS.iso;
    const p = projectHLR(shape, frame, { hidden: false });
    const e = extents([...p.visible, ...p.tangent]);
    extras.push({ name: "iso", frame, ortho: false, visible: p.visible, tangent: p.tangent, hidden: [], hatch: [], ...e, cell: [0, 0] });
  }
  extras.push(...sections);
  if (!views.length && !extras.length) throw new Error("nothing to draw: pass at least one view or section");
  let sheetName = opts.sheet ?? "A4";
  if (!SHEETS[sheetName]) throw new Error(`unknown sheet "${sheetName}"; use ${Object.keys(SHEETS).join(", ")}`);
  for (const x of extras) {
    if (!views.length) {
      x.cell = [0, 0];
      views.push(x);
      continue;
    }
    const cs = views.map((v) => v.cell[0]),
      rs = views.map((v) => v.cell[1]);
    const [c0, c1, r0, r1] = [Math.min(...cs), Math.max(...cs), Math.min(...rs), Math.max(...rs)];
    const prefer: [number, number] = x.name === "iso" ? [c1, r0] : [c1 + 1, 0];
    let best: { cell: [number, number]; fit: number; penalty: number } | null = null;
    for (let c = c0 - 1; c <= c1 + 1; c++)
      for (let r = r0 - 1; r <= r1 + 1; r++) {
        if (views.some((v) => v.cell[0] === c && v.cell[1] === r)) continue;
        x.cell = [c, r];
        const f = gridOf([...views, x]).fit(sheetName);
        const penalty = Math.abs(c - prefer[0]) + Math.abs(r - prefer[1]) + (c < 0 || (x.name !== "iso" && r < 0) ? 2 : 0);
        if (!best || f > best.fit * 1.02 || (f > best.fit / 1.02 && penalty < best.penalty)) best = { cell: [c, r], fit: f, penalty };
      }
    x.cell = best!.cell;
    views.push(x);
  }

  const { colIds, rowIds, colW, rowH, sumW, sumH, fit } = gridOf(views);
  const pick = (s: number) => SCALES.find((x) => x <= s * (1 + 1e-9)) ?? SCALES[SCALES.length - 1];
  if (!opts.sheet && !opts.scale && pick(fit("A4")) < 1 && pick(fit("A3")) > pick(fit("A4"))) sheetName = "A3";
  const [SW, SH] = SHEETS[sheetName];
  let scale = opts.scale ?? pick(fit(sheetName));
  if (!(scale > 0) || !Number.isFinite(scale)) throw new Error("scale must be a positive number (2 for 2:1, 0.5 for 1:2)");
  if (opts.scale && opts.scale > fit(sheetName) * 1.001) warnings.push(`at ${scaleLabel(scale)} the views don't fit on ${sheetName}; try a smaller scale or a bigger sheet`);

  // place cells, centered in the area above the title block
  const totalW = sumW * scale + GAP * (colIds.length - 1);
  const totalH = sumH * scale + GAP * (rowIds.length - 1);
  const areaW = SW - 2 * MARGIN,
    areaH = SH - 2 * MARGIN - TITLE_H;
  let x0 = MARGIN + (areaW - totalW) / 2,
    y0 = MARGIN + (areaH - totalH) / 2;
  const colX = new Map<number, number>(),
    rowY = new Map<number, number>();
  colIds.forEach((c, i) => {
    colX.set(c, x0 + colW[i] * scale / 2);
    x0 += colW[i] * scale + GAP;
  });
  rowIds.forEach((r, i) => {
    rowY.set(r, y0 + rowH[i] * scale / 2);
    y0 += rowH[i] * scale + GAP;
  });

  const prims: Prim[] = [];
  const toPaper = (v: View, p: P2): P2 => {
    const mx = (v.min[0] + v.max[0]) / 2,
      my = (v.min[1] + v.max[1]) / 2;
    return [v.at![0] + (p[0] - mx) * scale, v.at![1] - (p[1] - my) * scale];
  };
  for (const v of views) {
    v.at = [colX.get(v.cell[0])!, rowY.get(v.cell[1])!];
    for (const loops of v.hatch) prims.push({ k: "hatch", loops: loops.map((l) => l.map((p) => toPaper(v, p))), spacing: 2, angle: 45 });
    const put = (lines: P2[][], style: LineStyle) => {
      for (const l of lines) if (l.length >= 2) prims.push({ k: "line", pts: l.map((p) => toPaper(v, p)), style });
    };
    put(v.hidden, "hidden");
    put(v.tangent, "tangent");
    put(v.visible, "visible");
    if (v.label) {
      const bottom = v.at[1] + ((v.max[1] - v.min[1]) * scale) / 2;
      prims.push({ k: "text", at: [v.at[0], bottom + 10], text: `SECTION ${v.label}–${v.label}`, size: TEXT, anchor: "middle", bold: true });
    }
  }

  // cutting-plane lines on a view the plane is seen edge-on in; dimension text keeps clear of them
  const keepOut: P2[] = [];
  for (const c of cuts) {
    const host = views.find((v) => v.ortho && Math.abs(dot(v.frame.dir, c.normal)) < 1e-6);
    if (!host) {
      warnings.push(`section ${c.label}–${c.label}: no orthographic view shows its cutting plane edge-on, so the cutting line isn't drawn`);
      continue;
    }
    const along = toView(host.frame, crossV(c.normal, host.frame.dir));
    const L = Math.hypot(...along) || 1;
    const u: P2 = [along[0] / L, along[1] / L];
    const o = toView(host.frame, c.origin);
    // extend past the view's extents
    const cx = (host.min[0] + host.max[0]) / 2,
      cy = (host.min[1] + host.max[1]) / 2;
    const t0 = (cx - o[0]) * u[0] + (cy - o[1]) * u[1];
    const reach = Math.abs((host.max[0] - host.min[0]) * u[0]) / 2 + Math.abs((host.max[1] - host.min[1]) * u[1]) / 2 + 4 / scale;
    const a = toPaper(host, [o[0] + u[0] * (t0 - reach), o[1] + u[1] * (t0 - reach)]);
    const b = toPaper(host, [o[0] + u[0] * (t0 + reach), o[1] + u[1] * (t0 + reach)]);
    prims.push({ k: "line", pts: [a, b], style: "cutting" });
    // thick ends, arrows in the viewing direction (toward the removed material's far side)
    const look = toView(host.frame, [-c.normal[0], -c.normal[1], -c.normal[2]]);
    const ll = Math.hypot(...look) || 1;
    const dPaper: P2 = [look[0] / ll, -look[1] / ll];
    const seg = (p: P2, q: P2) => {
      const d: P2 = [q[0] - p[0], q[1] - p[1]];
      const n = Math.hypot(...d) || 1;
      return [p, [p[0] + (d[0] / n) * 5, p[1] + (d[1] / n) * 5]] as P2[];
    };
    for (const [p, q] of [[a, b], [b, a]] as [P2, P2][]) {
      prims.push({ k: "line", pts: seg(p, q), style: "visible" });
      const tip: P2 = [p[0] + dPaper[0] * 7, p[1] + dPaper[1] * 7];
      prims.push({ k: "line", pts: [p, tip], style: "thin" });
      prims.push(arrowHead(tip, dPaper));
      // the letter sits just past the arrow's tip
      const lc: P2 = [tip[0] + dPaper[0] * 3.5, tip[1] + dPaper[1] * 3.5];
      keepOut.push(p, tip, lc);
      prims.push({ k: "text", at: [lc[0], lc[1] + 1.75], text: c.label, size: 5, anchor: "middle", bold: true });
    }
  }

  // dimensions: each model axis once, on the first orthographic view that shows it
  if (opts.dimensions !== false) {
    const done = new Set<number>();
    for (const v of views.filter((w) => w.ortho && !w.label)) {
      const corners: Vec3[] = [];
      for (let i = 0; i < 8; i++) corners.push([i & 1 ? box.max[0] : box.min[0], i & 2 ? box.max[1] : box.min[1], i & 4 ? box.max[2] : box.min[2]]);
      const pts = corners.map((c) => toView(v.frame, c));
      const e = extents([pts]);
      const axisH = v.frame.x.findIndex((c) => Math.abs(c) > 0.5);
      const up = crossV(v.frame.dir, v.frame.x);
      const axisV = up.findIndex((c) => Math.abs(c) > 0.5);
      const bl = toPaper(v, [e.min[0], e.min[1]]),
        br = toPaper(v, [e.max[0], e.min[1]]),
        tl = toPaper(v, [e.min[0], e.max[1]]);
      if (!done.has(axisH) && e.max[0] - e.min[0] > 1e-6) {
        done.add(axisH);
        prims.push(...linearDim(bl, br, "below", fmtMM(e.max[0] - e.min[0]), keepOut));
      }
      if (!done.has(axisV) && e.max[1] - e.min[1] > 1e-6) {
        done.add(axisV);
        prims.push(...linearDim(tl, bl, "left", fmtMM(e.max[1] - e.min[1]), keepOut));
      }
    }
    // holes and round bosses seen end-on: center marks and diameter callouts
    prims.push(...holeCallouts(shape, views.filter((w) => w.ortho && !w.label), toPaper, scale));
  }

  // frame and title block
  prims.push({ k: "line", pts: [[MARGIN, MARGIN], [SW - MARGIN, MARGIN], [SW - MARGIN, SH - MARGIN], [MARGIN, SH - MARGIN]], closed: true, style: "frame" });
  prims.push(...titleBlock(SW, SH, {
    title: opts.title ?? "Part",
    description: opts.meta?.description,
    document: opts.document,
    part: opts.meta?.partNumber ?? opts.meta?.part,
    material: opts.meta?.material,
    scale: scaleLabel(scale),
    sheet: sheetName,
    version: opts.version,
    date: opts.date ?? new Date().toISOString().slice(0, 10),
    author: opts.author,
    projection,
  }));

  const sheet: Sheet = { width: SW, height: SH, title: opts.title ?? "Drawing", prims };
  const format = opts.format ?? "svg";
  const result: DrawingResult = { format, sheet: sheetName, scale, scaleLabel: scaleLabel(scale), views: views.map((v) => ({ name: v.name, ...(v.label && { label: v.label }), at: v.at!, size: [(v.max[0] - v.min[0]) * scale, (v.max[1] - v.min[1]) * scale] as P2 })), warnings };
  if (format === "pdf") result.pdf = sheetToPDF(sheet);
  else result.svg = sheetToSVG(sheet);
  return result;
}

function arrowHead(tip: P2, dir: P2, len = 3, w = 1): Prim {
  const n: P2 = [-dir[1], dir[0]];
  const b: P2 = [tip[0] - dir[0] * len, tip[1] - dir[1] * len];
  return { k: "fill", pts: [tip, [b[0] + n[0] * w / 2, b[1] + n[1] * w / 2], [b[0] - n[0] * w / 2, b[1] - n[1] * w / 2]] };
}

/** A horizontal dimension below `a`–`b`, or a vertical one left of them (paper points). */
function linearDim(a: P2, b: P2, side: "below" | "left", text: string, keepOut: P2[] = []): Prim[] {
  // the first spot along the dimension line whose text box stays clear of `keepOut` (cutting-line ends, letters)
  const clear = (x0: number, y0: number, x1: number, y1: number) => keepOut.every(([x, y]) => x < Math.min(x0, x1) - 3 || x > Math.max(x0, x1) + 3 || y < Math.min(y0, y1) - 3 || y > Math.max(y0, y1) + 3);
  const along = (lo: number, hi: number, w: number, box: (c: number) => [number, number, number, number]) => [0.5, 0.25, 0.75, 0.15, 0.85].map((t) => lo + (hi - lo) * t).find((c) => c - w / 2 > lo + 3 && c + w / 2 < hi - 3 && clear(...box(c)));
  const out: Prim[] = [];
  if (side === "below") {
    const y = Math.max(a[1], b[1]) + DIM_OFFSET;
    out.push({ k: "line", pts: [[a[0], a[1] + 1.5], [a[0], y + 1.5]], style: "thin" }, { k: "line", pts: [[b[0], b[1] + 1.5], [b[0], y + 1.5]], style: "thin" });
    const [l, r] = a[0] < b[0] ? [a[0], b[0]] : [b[0], a[0]];
    // short spans: arrows outside, pointing in
    if (r - l < 8) out.push({ k: "line", pts: [[l - 6, y], [r + 6, y]], style: "thin" }, arrowHead([l, y], [1, 0]), arrowHead([r, y], [-1, 0]));
    else out.push({ k: "line", pts: [[l, y], [r, y]], style: "thin" }, arrowHead([l, y], [-1, 0]), arrowHead([r, y], [1, 0]));
    const w = textWidth(text, TEXT);
    // too narrow for the text between the arrows: put it to the right
    if (w + 2 > r - l) out.push({ k: "text", at: [r + 7, y + TEXT * 0.35], text, size: TEXT });
    else {
      const c = along(l, r, w, (cx) => [cx - w / 2, y - 1 - TEXT, cx + w / 2, y - 1]) ?? (l + r) / 2;
      out.push({ k: "text", at: [c, y - 1], text, size: TEXT, anchor: "middle" });
    }
  } else {
    const x = Math.min(a[0], b[0]) - DIM_OFFSET;
    out.push({ k: "line", pts: [[a[0] - 1.5, a[1]], [x - 1.5, a[1]]], style: "thin" }, { k: "line", pts: [[b[0] - 1.5, b[1]], [x - 1.5, b[1]]], style: "thin" });
    const [t, btm] = a[1] < b[1] ? [a[1], b[1]] : [b[1], a[1]];
    if (btm - t < 8) out.push({ k: "line", pts: [[x, t - 6], [x, btm + 6]], style: "thin" }, arrowHead([x, t], [0, 1]), arrowHead([x, btm], [0, -1]));
    else out.push({ k: "line", pts: [[x, t], [x, btm]], style: "thin" }, arrowHead([x, t], [0, -1]), arrowHead([x, btm], [0, 1]));
    const w = textWidth(text, TEXT);
    if (w + 2 > btm - t) out.push({ k: "text", at: [x - 2, (t + btm) / 2 + TEXT * 0.35], text, size: TEXT, anchor: "end" });
    else {
      const c = along(t, btm, w, (cy) => [x - 1 - TEXT, cy - w / 2, x - 1, cy + w / 2]) ?? (t + btm) / 2;
      out.push({ k: "text", at: [x - 1, c], text, size: TEXT, anchor: "middle", rotate: -90 });
    }
  }
  return out;
}

/**
 * Center marks and Ø callouts for full circles seen end-on in an orthographic view (holes,
 * bosses). Each axis is called out once, in the first view that shows it; concentric circles
 * (a chamfered hole) show the smallest. Same diameters in a view share one callout ("4× Ø5").
 */
function holeCallouts(shape: Shape, views: View[], toPaper: (v: View, p: P2) => P2, scale: number): Prim[] {
  // full circles bounding a cylindrical face of the same radius: the ends of holes and bosses (not
  // fillet or chamfer boundaries)
  const circles: { r: number; c: Vec3; axis: Vec3 }[] = [];
  const faces = explore(shape, "face").items;
  for (const f of faces) {
    try {
      const fi = faceInfo(f);
      if (fi.surface !== "cylinder" || !fi.radius) continue;
      const edges = explore(f, "edge").items;
      for (const e of edges) {
        const i = edgeInfo(e);
        if (i.curve === "circle" && i.closed && i.radius && i.center && i.axis && Math.abs(i.radius - fi.radius) < 1e-6 * Math.max(1, fi.radius)) circles.push({ r: i.radius, c: i.center, axis: unit(i.axis) });
        e.delete();
      }
    } catch {
    } finally {
      f.delete();
    }
  }
  const out: Prim[] = [];
  const seen = new Set<string>();
  const key = (v: number) => Math.round(v * 100) / 100;
  for (const v of views) {
    // smallest circle per (center in view) among those square to the view
    const byCenter = new Map<string, { p: P2; r: number; line: string }>();
    for (const c of circles) {
      if (Math.abs(Math.abs(dot(c.axis, v.frame.dir)) - 1) > 1e-6) continue;
      const p = toView(v.frame, c.c);
      const k = `${key(p[0])},${key(p[1])}`;
      const line = `${v.frame.dir.map((d) => Math.abs(Math.round(d))).join("")}|${k}`;
      const have = byCenter.get(k);
      if (!have || c.r < have.r) byCenter.set(k, { p, r: c.r, line });
    }
    const groups = new Map<string, { p: P2; r: number }[]>();
    for (const h of byCenter.values()) {
      // the same axis seen from the opposite side (front/back) is the same hole
      const lineKey = `${h.line}|${key(h.r)}`;
      if (seen.has(lineKey)) continue;
      seen.add(lineKey);
      const d = fmtMM(2 * h.r);
      groups.set(d, [...(groups.get(d) ?? []), h]);
    }
    for (const [d, hs] of groups) {
      for (const h of hs) {
        const c = toPaper(v, h.p);
        const R = h.r * scale + 2;
        out.push({ k: "line", pts: [[c[0] - R, c[1]], [c[0] + R, c[1]]], style: "center" }, { k: "line", pts: [[c[0], c[1] - R], [c[0], c[1] + R]], style: "center" });
      }
      if (out.length > 200) break;
      const h = hs[0];
      const c = toPaper(v, h.p);
      const r = h.r * scale;
      const dir: P2 = [Math.SQRT1_2, -Math.SQRT1_2];
      const onCircle: P2 = [c[0] + dir[0] * r, c[1] + dir[1] * r];
      const elbow: P2 = [c[0] + dir[0] * (r + 8), c[1] + dir[1] * (r + 8)];
      const text = `${hs.length > 1 ? `${hs.length}× ` : ""}Ø${d}`;
      const end: P2 = [elbow[0] + textWidth(text, TEXT) + 2, elbow[1]];
      out.push({ k: "line", pts: [onCircle, elbow, end], style: "thin" }, arrowHead(onCircle, [-dir[0], -dir[1]], 2.5, 0.9), { k: "text", at: [elbow[0] + 1, elbow[1] - 1], text, size: TEXT });
    }
  }
  return out;
}

type TitleFields = { title: string; description?: string; document?: string; part?: string; material?: string; scale: string; sheet: string; version?: string; date: string; author?: string; projection: "third" | "first" };

function titleBlock(SW: number, SH: number, t: TitleFields): Prim[] {
  const w = Math.min(180, SW - 2 * MARGIN);
  const x0 = SW - MARGIN - w,
    y0 = SH - MARGIN - TITLE_H;
  const out: Prim[] = [];
  const rect = (x: number, y: number, ww: number, hh: number) => out.push({ k: "line", pts: [[x, y], [x + ww, y], [x + ww, y + hh], [x, y + hh]], closed: true, style: "thin" });
  rect(x0, y0, w, TITLE_H);
  const fit = (s: string, size: number, room: number, bold = false) => {
    let v = s;
    while (v.length > 1 && textWidth(v, size, bold) > room) v = v.slice(0, -2) + "…";
    return v.replace(/…+$/, "…");
  };
  const cell = (x: number, y: number, ww: number, hh: number, label: string, value: string | undefined, size = 3) => {
    rect(x, y, ww, hh);
    out.push({ k: "text", at: [x + 1.2, y + 2.6], text: label, size: 1.9 });
    if (value) out.push({ k: "text", at: [x + 1.2, y + hh - 1.6], text: fit(value, size, ww - 2.4), size });
  };
  const aw = w - 80; // title column
  // title and description
  rect(x0, y0, aw, 16);
  out.push({ k: "text", at: [x0 + 2, y0 + 8.5], text: fit(t.title, 6, aw - 4, true), size: 6, bold: true });
  if (t.description) out.push({ k: "text", at: [x0 + 2, y0 + 13.6], text: fit(t.description, 3, aw - 4), size: 3 });
  cell(x0, y0 + 16, aw / 2, 8, "DOCUMENT", t.document);
  cell(x0 + aw / 2, y0 + 16, aw / 2, 8, "PART", t.part);
  cell(x0, y0 + 24, aw / 2, 8, "MATERIAL", t.material ?? "—");
  cell(x0 + aw / 2, y0 + 24, aw / 2, 8, "DRAWN BY", t.author);
  const bx = x0 + aw;
  cell(bx, y0, 40, 8, "SCALE", t.scale);
  cell(bx + 40, y0, 40, 8, "UNITS", "mm");
  cell(bx, y0 + 8, 40, 8, "DATE", t.date);
  cell(bx + 40, y0 + 8, 40, 8, "VERSION", t.version);
  cell(bx, y0 + 16, 40, 8, "SHEET", `${t.sheet} · 1 of 1`);
  cell(bx + 40, y0 + 16, 40, 8, "GENERAL TOLERANCE", "ISO 2768-m");
  // projection symbol (ISO 5456-2): front view of a truncated cone and its end view
  rect(bx, y0 + 24, 80, 8);
  out.push({ k: "text", at: [bx + 1.2, y0 + 26.6], text: t.projection === "third" ? "THIRD ANGLE PROJECTION" : "FIRST ANGLE PROJECTION", size: 1.9 });
  const cy = y0 + 28.4;
  const cone = (x: number): Prim => ({ k: "line", pts: [[x, cy - 1.3], [x + 5, cy - 2.6], [x + 5, cy + 2.6], [x, cy + 1.3]], closed: true, style: "thin" });
  const ends = (x: number): Prim[] => [{ k: "circle", c: [x, cy], r: 2.6, style: "thin" }, { k: "circle", c: [x, cy], r: 1.3, style: "thin" }];
  if (t.projection === "third") out.push(...ends(bx + 58), cone(bx + 63));
  else out.push(cone(bx + 55), ...ends(bx + 66));
  return out;
}
