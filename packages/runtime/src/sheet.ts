// A drawing sheet as plain primitives in paper millimeters (y down), and its SVG and PDF writers.
// Line types follow ISO 128: thick continuous for visible edges, thin dashed for hidden ones,
// thin chain for center and cutting-plane lines.
import { zlibSync } from "fflate";

export type P2 = [number, number];

export type LineStyle = "visible" | "hidden" | "tangent" | "thin" | "center" | "cutting" | "frame";

export type Prim =
  | { k: "line"; pts: P2[]; style: LineStyle; closed?: boolean }
  | { k: "circle"; c: P2; r: number; style: LineStyle }
  /** Cut material: closed loops filled with 45° hatching (even-odd, so holes stay open). */
  | { k: "hatch"; loops: P2[][]; spacing: number; angle: number }
  /** Solid black fill (arrowheads). */
  | { k: "fill"; pts: P2[] }
  /** `at` is the baseline anchor; `rotate` in degrees, clockwise in paper coordinates (SVG). */
  | { k: "text"; at: P2; text: string; size: number; anchor?: "start" | "middle" | "end"; bold?: boolean; rotate?: number };

export type Sheet = { width: number; height: number; title: string; prims: Prim[] };

const STYLE: Record<LineStyle, { width: number; dash?: number[]; color: string }> = {
  visible: { width: 0.5, color: "#000" },
  frame: { width: 0.7, color: "#000" },
  hidden: { width: 0.25, dash: [2, 1], color: "#000" },
  tangent: { width: 0.18, color: "#555" },
  thin: { width: 0.18, color: "#000" },
  center: { width: 0.18, dash: [6, 1.2, 0.8, 1.2], color: "#000" },
  cutting: { width: 0.35, dash: [8, 1.5, 1, 1.5], color: "#000" },
};

const f = (x: number) => {
  const r = Math.round(x * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
};
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function sheetToSVG(sheet: Sheet): string {
  const out: string[] = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${f(sheet.width)}mm" height="${f(sheet.height)}mm" viewBox="0 0 ${f(sheet.width)} ${f(sheet.height)}" font-family="Helvetica, Arial, sans-serif">`);
  out.push(`<title>${esc(sheet.title)}</title>`);
  const hatches = sheet.prims.filter((p): p is Extract<Prim, { k: "hatch" }> => p.k === "hatch");
  const patterns = new Map<string, string>();
  for (const h of hatches) {
    const key = `${h.spacing}|${h.angle}`;
    if (!patterns.has(key)) patterns.set(key, `hatch${patterns.size}`);
  }
  out.push(`<defs>${[...patterns].map(([key, id]) => {
    const [sp, ang] = key.split("|").map(Number);
    return `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${f(sp)}" height="${f(sp)}" patternTransform="rotate(${f(-ang)})"><line x1="0" y1="${f(sp / 2)}" x2="${f(sp)}" y2="${f(sp / 2)}" stroke="#000" stroke-width="0.25"/></pattern>`;
  }).join("")}</defs>`);
  out.push(`<rect x="0" y="0" width="${f(sheet.width)}" height="${f(sheet.height)}" fill="#fff"/>`);
  const strokeAttrs = (s: LineStyle) => {
    const st = STYLE[s];
    return `fill="none" stroke="${st.color}" stroke-width="${st.width}" stroke-linecap="round" stroke-linejoin="round"${st.dash ? ` stroke-dasharray="${st.dash.join(" ")}"` : ""}`;
  };
  const d = (pts: P2[], closed?: boolean) => `M${pts.map((p) => `${f(p[0])} ${f(p[1])}`).join("L")}${closed ? "Z" : ""}`;
  for (const p of sheet.prims) {
    if (p.k === "line") out.push(`<path d="${d(p.pts, p.closed)}" ${strokeAttrs(p.style)}/>`);
    else if (p.k === "circle") out.push(`<circle cx="${f(p.c[0])}" cy="${f(p.c[1])}" r="${f(p.r)}" ${strokeAttrs(p.style)}/>`);
    else if (p.k === "hatch") out.push(`<path d="${p.loops.map((l) => d(l, true)).join("")}" fill="url(#${patterns.get(`${p.spacing}|${p.angle}`)})" fill-rule="evenodd" stroke="none"/>`);
    else if (p.k === "fill") out.push(`<path d="${d(p.pts, true)}" fill="#000" stroke="none"/>`);
    else if (p.k === "text") {
      const tr = p.rotate ? ` transform="rotate(${f(p.rotate)} ${f(p.at[0])} ${f(p.at[1])})"` : "";
      out.push(`<text x="${f(p.at[0])}" y="${f(p.at[1])}" font-size="${f(p.size)}"${p.anchor && p.anchor !== "start" ? ` text-anchor="${p.anchor}"` : ""}${p.bold ? ` font-weight="bold"` : ""}${tr}>${esc(p.text)}</text>`);
    }
  }
  out.push(`</svg>`);
  return out.join("\n");
}

// ---------- PDF ----------

// Helvetica advance widths (1/1000 em) for WinAnsi 32..126, for anchoring text in the PDF.
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HELV_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
/** Unicode -> WinAnsi for the few non-ASCII characters drawings use. */
const WIN: Record<string, [number, number]> = { "Ø": [0xd8, 778], "·": [0xb7, 278], "—": [0x97, 1000], "…": [0x85, 1000], "‘": [0x91, 222], "’": [0x92, 222], "“": [0x93, 333], "”": [0x94, 333], "é": [0xe9, 556], "ä": [0xe4, 556], "ö": [0xf6, 556], "ü": [0xfc, 556], "×": [0xd7, 584], "–": [0x96, 556], "°": [0xb0, 400], "³": [0xb3, 333], "²": [0xb2, 333], "±": [0xb1, 584], "µ": [0xb5, 556] };

function winAnsi(s: string, bold: boolean): { bytes: number[]; width: number } {
  const bytes: number[] = [];
  let width = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 32 && c <= 126) {
      bytes.push(c);
      width += (bold ? HELV_BOLD : HELV)[c - 32];
    } else if (WIN[ch]) {
      bytes.push(WIN[ch][0]);
      width += WIN[ch][1];
    } else {
      bytes.push(63); // "?"
      width += 556;
    }
  }
  return { bytes, width: width / 1000 };
}

/** Width of a string in paper mm at `size` (Helvetica metrics). */
export function textWidth(s: string, size: number, bold = false) {
  return winAnsi(s, bold).width * size;
}

export function sheetToPDF(sheet: Sheet): Uint8Array {
  const k = 72 / 25.4;
  const W = sheet.width * k,
    H = sheet.height * k;
  const ops: string[] = [];
  // millimeters, y down: everything below is in paper coordinates
  ops.push(`${f(k)} 0 0 ${f(-k)} 0 ${f(H)} cm`, "1 J 1 j");
  let cur = "";
  const setStyle = (s: LineStyle) => {
    if (cur === s) return;
    cur = s;
    const st = STYLE[s];
    const g = st.color === "#000" ? 0 : 0.33;
    ops.push(`${f(st.width)} w ${f(g)} G [${(st.dash ?? []).map(f).join(" ")}] 0 d`);
  };
  const path = (pts: P2[], closed?: boolean) => {
    ops.push(`${f(pts[0][0])} ${f(pts[0][1])} m`);
    for (let i = 1; i < pts.length; i++) ops.push(`${f(pts[i][0])} ${f(pts[i][1])} l`);
    if (closed) ops.push("h");
  };
  const circle = (c: P2, r: number) => {
    const m = 0.5523 * r;
    const [x, y] = c;
    ops.push(`${f(x + r)} ${f(y)} m`, `${f(x + r)} ${f(y + m)} ${f(x + m)} ${f(y + r)} ${f(x)} ${f(y + r)} c`, `${f(x - m)} ${f(y + r)} ${f(x - r)} ${f(y + m)} ${f(x - r)} ${f(y)} c`, `${f(x - r)} ${f(y - m)} ${f(x - m)} ${f(y - r)} ${f(x)} ${f(y - r)} c`, `${f(x + m)} ${f(y - r)} ${f(x + r)} ${f(y - m)} ${f(x + r)} ${f(y)} c`);
  };
  const texts: { bytes: number[]; tm: string; bold: boolean }[] = [];
  for (const p of sheet.prims) {
    if (p.k === "line") {
      if (p.pts.length < 2) continue;
      setStyle(p.style);
      path(p.pts, p.closed);
      ops.push("S");
    } else if (p.k === "circle") {
      setStyle(p.style);
      circle(p.c, p.r);
      ops.push("S");
    } else if (p.k === "fill") {
      ops.push("0 g");
      path(p.pts, true);
      ops.push("f");
    } else if (p.k === "hatch") {
      const pts = p.loops.flat();
      if (!pts.length) continue;
      ops.push("q");
      for (const l of p.loops) path(l, true);
      ops.push("W* n");
      cur = "";
      ops.push("0.18 w 0 G [] 0 d");
      // lines at `angle` (counterclockwise on paper) across the loops' bounding circle
      const xs = pts.map((q) => q[0]),
        ys = pts.map((q) => q[1]);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2,
        cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      const R = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2 + p.spacing;
      const a = (p.angle * Math.PI) / 180;
      const u: P2 = [Math.cos(a), -Math.sin(a)],
        n: P2 = [Math.sin(a), Math.cos(a)];
      for (let t = -R; t <= R; t += p.spacing) ops.push(`${f(cx + n[0] * t - u[0] * R)} ${f(cy + n[1] * t - u[1] * R)} m ${f(cx + n[0] * t + u[0] * R)} ${f(cy + n[1] * t + u[1] * R)} l`);
      ops.push("S Q");
    } else if (p.k === "text") {
      const { bytes, width } = winAnsi(p.text, !!p.bold);
      const w = width * p.size;
      const a = ((p.rotate ?? 0) * Math.PI) / 180;
      const u: P2 = [Math.cos(a), Math.sin(a)];
      const v: P2 = [Math.sin(a), -Math.cos(a)]; // glyph up, in y-down paper coordinates
      const shift = p.anchor === "middle" ? w / 2 : p.anchor === "end" ? w : 0;
      const x = p.at[0] - u[0] * shift,
        y = p.at[1] - u[1] * shift;
      texts.push({ bytes, bold: !!p.bold, tm: `${f(u[0] * p.size)} ${f(u[1] * p.size)} ${f(v[0] * p.size)} ${f(v[1] * p.size)} ${f(x)} ${f(y)} Tm` });
    }
  }
  // the content stream is latin-1: text strings carry raw WinAnsi bytes
  const head = ops.join("\n") + "\n0 g\n";
  const parts: number[] = [];
  const pushStr = (s: string) => {
    for (let i = 0; i < s.length; i++) parts.push(s.charCodeAt(i) & 0xff);
  };
  pushStr(head);
  for (const t of texts) {
    pushStr(`BT /${t.bold ? "F2" : "F1"} 1 Tf ${t.tm} (`);
    for (const b of t.bytes) {
      if (b === 0x28 || b === 0x29 || b === 0x5c) parts.push(0x5c);
      parts.push(b);
    }
    pushStr(") Tj ET\n");
  }
  const content = zlibSync(new Uint8Array(parts), { level: 6 });

  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const enc = (s: string) => {
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    return b;
  };
  const emit = (b: Uint8Array) => {
    chunks.push(b);
    pos += b.length;
  };
  const obj = (n: number, body: string | Uint8Array[]) => {
    offsets[n] = pos;
    if (typeof body === "string") emit(enc(`${n} 0 obj\n${body}\nendobj\n`));
    else {
      emit(enc(`${n} 0 obj\n`));
      for (const b of body) emit(b);
      emit(enc(`\nendobj\n`));
    }
  };
  emit(enc("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"));
  const title = sheet.title.replace(/[\\()]/g, "\\$&").replace(/[^\x20-\x7e]/g, "?");
  obj(1, `<< /Type /Catalog /Pages 2 0 R >>`);
  obj(2, `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`);
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(W)} ${f(H)}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`);
  obj(4, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`);
  obj(5, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`);
  obj(6, [enc(`<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`), content, enc(`\nendstream`)]);
  obj(7, `<< /Title (${title}) /Producer (Parasocial) >>`);
  const xref = pos;
  let x = `xref\n0 8\n0000000000 65535 f \n`;
  for (let i = 1; i <= 7; i++) x += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  x += `trailer\n<< /Size 8 /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  emit(enc(x));
  const out = new Uint8Array(pos);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
