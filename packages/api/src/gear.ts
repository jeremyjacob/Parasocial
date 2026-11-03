// Involute gears as one primitive: spur, helical and herringbone, exact flanks, every face named.
import { gearBody, faceSample, type GearProfileEdge, type Vec3 } from "@parasocial/kernel";
import { runOp, userError, warn } from "./op";
import { Solid } from "./solid";
import { num, positive, int, nonNegative } from "./check";

/** Options of `gear(...)`. Lengths mm, angles degrees. */
export type GearOpts = {
  /** Number of teeth. */
  teeth: number;
  /**
   * Module (mm): pitch diameter / teeth, measured in the end (transverse) section, so the pitch
   * diameter is `module × teeth` whatever the helix angle.
   */
  module: number;
  /** Face width along Z: the gear spans z = 0..width. */
  width: number;
  /** Pressure angle (transverse). Default 20. */
  pressureAngle?: number;
  /** Helix angle at the pitch circle; the sign is the hand (+ right, − left). Meshing external gears take opposite hands. Default 0 (spur). */
  helix?: number;
  /** V teeth (needs `helix`): the two arms meet at z = apex (default width / 2). */
  herringbone?: boolean | { apex: number };
  /** Thins each tooth by this much around the pitch circle (mm), for running clearance. Default 0. */
  backlash?: number;
  /** Profile shift coefficient x (addendum and root move out by x·module). Default 0. */
  profileShift?: number;
  /** Root fillet radius, × module. Default 0.38 (at most what the tooth gap allows). */
  rootFillet?: number;
  /** Tip relief (mm): each flank eases off the involute by up to this much at the tip, starting halfway up the addendum. Default 0. */
  tipRelief?: number;
  /** Plain bore diameter. */
  bore?: number;
  /** Angle of tooth 0's centre at z = 0 (at the apex for a herringbone). Default 0. */
  phase?: number;
  /** Ring gear (teeth inward). Not supported yet. */
  internal?: boolean;
  /** Below the undercut limit (17 teeth at 20°, unshifted), warn instead of failing. The flank then runs radially below the base circle (no trochoid). */
  allowUndercut?: boolean;
  tag?: string;
};

/** What a gear solid knows about itself (for `gear.centerDistance` / `gear.meshPhase`). */
export type GearInfo = {
  teeth: number;
  module: number;
  pressureAngle: number;
  helix: number;
  profileShift: number;
  phase: number;
  /** Pitch radius (mm). */
  pitchRadius: number;
  /** Tip (outside) radius. */
  tipRadius: number;
  /** Root radius. */
  rootRadius: number;
  /** z of the reference section: 0, or the apex of a herringbone. */
  zReference: number;
};

/** Anything the helpers accept as a gear: a gear solid, its info, or the options it was (or will be) built from. */
export type GearLike = Solid | GearInfo | Pick<GearOpts, "teeth" | "module" | "pressureAngle" | "profileShift" | "phase" | "helix">;

const DEG = Math.PI / 180;
const inv = (a: number) => Math.tan(a) - a;

type Geo = {
  N: number;
  m: number;
  alpha: number;
  rp: number;
  rb: number;
  ra: number;
  rf: number;
  /** Half tooth angle at the pitch circle (rad). */
  psiP: number;
  relief: number;
  /** Radius where the relief starts. */
  rRelief: number;
  /** Lowest radius of the involute flank (where the root curve takes over). */
  rlo: number;
  /** The root curve of the gap centred on angle 0, as composite pieces (line / arc). */
  root: Piece[];
};

type Piece = { kind: "line"; a: [number, number]; b: [number, number] } | { kind: "arc"; c: [number, number]; r: number; t0: number; t1: number };

/** Half tooth angle at radius r ≥ rb, before relief. */
const psiInv = (g: Pick<Geo, "psiP" | "alpha" | "rb">, r: number) => g.psiP + inv(g.alpha) - inv(Math.acos(Math.min(1, g.rb / Math.max(r, g.rb))));
/** Half tooth angle with tip relief (radians). */
function psi(g: Geo, r: number) {
  let p = psiInv(g, r);
  if (g.relief > 0 && r > g.rRelief) p -= (g.relief * ((r - g.rRelief) / (g.ra - g.rRelief)) ** 2) / r;
  return p;
}

/** Point on a flank of the tooth centred on angle c: side −1 left (smaller angle), +1 right. */
function flankPoint(g: Geo, r: number, c: number, side: number): [number, number] {
  const a = c + side * psi(g, r);
  return [r * Math.cos(a), r * Math.sin(a)];
}

/** Validate and resolve the geometry (throws user errors). */
function geometry(o: Required<Pick<GearOpts, "teeth" | "module" | "pressureAngle" | "backlash" | "profileShift" | "rootFillet" | "tipRelief">> & { allowUndercut: boolean; bore?: number }): Geo {
  const N = o.teeth,
    m = o.module,
    x = o.profileShift,
    alpha = o.pressureAngle * DEG;
  const rp = (m * N) / 2,
    rb = rp * Math.cos(alpha),
    ra = rp + m * (1 + x),
    rf = rp - m * (1.25 - x);
  // undercut: the generating rack's tip line cuts below the base circle's tangent point
  const nMin = (2 * (1 - x)) / Math.sin(alpha) ** 2;
  if (N < nMin - 1e-9) {
    const xMin = 1 - (N * Math.sin(alpha) ** 2) / 2;
    const msg = `gear: ${N} teeth at ${o.pressureAngle}° are undercut${x ? ` with profileShift ${x}` : ""}; use at least ${Math.ceil(nMin - 1e-9)} teeth, profileShift ≥ ${(Math.ceil(xMin * 100) / 100).toFixed(2)}, or allowUndercut: true`;
    if (o.allowUndercut) warn(msg.replace(/; use at least.*$/, " (allowed: the flank runs radially below the base circle)"), "operation");
    else userError(msg);
  }
  if (!(rf > 0)) userError(`gear: the root circle is at radius ${rf.toFixed(3)}; use more teeth or a larger profileShift`);
  const s = m * (Math.PI / 2 + 2 * x * Math.tan(alpha)) - o.backlash;
  if (!(s > 0)) userError(`gear: backlash ${o.backlash} leaves no tooth (the tooth is ${(s + o.backlash).toFixed(3)} mm thick at the pitch circle)`);
  const base = { psiP: s / (2 * rp), alpha, rb };
  if (!(psiInv(base, ra) > 0)) userError(`gear: the teeth come to a point below the tip circle; use a smaller profileShift or backlash`);
  const gapAt = (r: number) => Math.PI / N - psiInv(base, r);
  if (!(gapAt(Math.max(rf, rb)) > 0)) userError(`gear: the teeth leave no gap at the root; use more teeth or a smaller profileShift`);
  if (o.bore !== undefined && o.bore / 2 >= rf - 1e-6) userError(`gear: bore ${o.bore} reaches the root circle (Ø${(2 * rf).toFixed(3)})`);
  const rRelief = Math.max((rp + ra) / 2, Math.max(rb, rf));
  const g: Geo = { N, m, alpha, rp, rb, ra, rf, psiP: base.psiP, relief: o.tipRelief, rRelief, rlo: Math.max(rb, rf), root: [] };
  if (o.tipRelief > 0 && !(psi(g, ra) > 0)) userError(`gear: tipRelief ${o.tipRelief} brings the teeth to a point; use a smaller tipRelief`);
  fitRoot(g, o.rootFillet * m);
  g.rRelief = Math.max(g.rRelief, g.rlo);
  return g;
}

/**
 * The root of the gap centred on angle 0: from the left wall (the right flank of the tooth below,
 * at angle −γ(r) = −(π/N − ψ(r))), a fillet of radius ρ tangent to the wall and the root circle,
 * the root arc, and the mirror image. The wall is the involute above the base circle and a radial
 * line below it. ρ is reduced to what the gap allows.
 */
function fitRoot(g: Geo, rho: number) {
  const { N, rb, rf, ra } = g;
  const gamma = (r: number) => Math.PI / N - psiInv(g, Math.max(r, rb));
  const wall = (r: number): [number, number] => [r * Math.cos(-gamma(r)), r * Math.sin(-gamma(r))];
  const r0 = rf;
  /** Closest wall point to c: [distance, radius]. */
  const closest = (c: [number, number]): [number, number] => {
    const d = (r: number) => Math.hypot(wall(r)[0] - c[0], wall(r)[1] - c[1]);
    const n = 64;
    let best = r0,
      bd = Infinity;
    for (let i = 0; i <= n; i++) {
      const r = r0 + ((ra - r0) * i) / n;
      const v = d(r);
      if (v < bd) (bd = v), (best = r);
    }
    let lo = Math.max(r0, best - (ra - r0) / n),
      hi = Math.min(ra, best + (ra - r0) / n);
    for (let i = 0; i < 60; i++) {
      const a = lo + (hi - lo) * 0.382,
        b = lo + (hi - lo) * 0.618;
      if (d(a) < d(b)) hi = b;
      else lo = a;
    }
    const r = (lo + hi) / 2;
    return [d(r), r];
  };
  const center = (rr: number, beta: number): [number, number] => [(rf + rr) * Math.cos(-beta), (rf + rr) * Math.sin(-beta)];
  const pieces: Piece[] = [];
  if (rho > 0) {
    // the largest fillet that fits: centred on the gap's middle line
    if (closest(center(rho, 0))[0] < rho) {
      let lo = 0,
        hi = rho;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (closest(center(mid, 0))[0] >= mid) lo = mid;
        else hi = mid;
      }
      rho = lo;
    }
  }
  if (rho > 1e-6) {
    // centre angle β (from the gap's middle) where the fillet touches the wall
    let lo = 0,
      hi = gamma(rf);
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (closest(center(rho, mid))[0] >= rho) lo = mid;
      else hi = mid;
    }
    const beta = lo;
    const c = center(rho, beta);
    const [, rt] = closest(c);
    const T = wall(rt);
    g.rlo = Math.max(rt, rb);
    if (rt < rb - 1e-9) pieces.push({ kind: "line", a: wall(rb), b: T });
    const tT = Math.atan2(T[1] - c[1], T[0] - c[0]);
    const tB = -beta + Math.PI; // from the centre toward the root circle (inward)
    // the fillet runs from the wall down to the root circle: the short way round
    let t1 = Math.atan2(Math.sin(tB), Math.cos(tB));
    while (t1 - tT > Math.PI) t1 -= 2 * Math.PI;
    while (tT - t1 > Math.PI) t1 += 2 * Math.PI;
    pieces.push({ kind: "arc", c, r: rho, t0: tT, t1 });
    if (beta > 1e-9) pieces.push({ kind: "arc", c: [0, 0], r: rf, t0: -beta, t1: beta });
  } else {
    g.rlo = Math.max(rb, rf);
    if (rf < rb) pieces.push({ kind: "line", a: wall(rb), b: wall(rf) });
    pieces.push({ kind: "arc", c: [0, 0], r: rf, t0: -gamma(rf), t1: gamma(rf) });
  }
  // mirror the left half (all but a centred root arc) about the x axis, reversed
  const mirror = (p: [number, number]): [number, number] => [p[0], -p[1]];
  const right: Piece[] = [];
  for (const p of [...pieces].reverse()) {
    if (p.kind === "arc" && p.c[0] === 0 && p.c[1] === 0) continue;
    if (p.kind === "line") right.push({ kind: "line", a: mirror(p.b), b: mirror(p.a) });
    else right.push({ kind: "arc", c: mirror(p.c), r: p.r, t0: -p.t1, t1: -p.t0 });
  }
  g.root = [...pieces, ...right];
}

/**
 * One smooth curve through composite pieces (lines and arcs, joined G1): a spline interpolating
 * points sampled densely from the exact pieces. (An exact rational B-spline throws OCCT's area and
 * volume integration off by far more than this curve deviates.)
 */
function compositeCurve(pieces: Piece[], rot: number, z: number, first: [number, number], last: [number, number]): GearProfileEdge {
  const pts: [number, number][] = [];
  for (const p of pieces) {
    const n = p.kind === "line" ? 3 : Math.max(4, Math.ceil(Math.abs(p.t1 - p.t0) / (Math.PI / 24)));
    for (let i = pts.length ? 1 : 0; i <= n; i++) {
      const t = i / n;
      if (p.kind === "line") pts.push([p.a[0] + (p.b[0] - p.a[0]) * t, p.a[1] + (p.b[1] - p.a[1]) * t]);
      else {
        const a = p.t0 + (p.t1 - p.t0) * t;
        pts.push([p.c[0] + p.r * Math.cos(a), p.c[1] + p.r * Math.sin(a)]);
      }
    }
  }
  // tangents at the ends: along the first and last piece
  const dir = (p: Piece, end: boolean): [number, number] => {
    if (p.kind === "line") return [p.b[0] - p.a[0], p.b[1] - p.a[1]];
    const a = end ? p.t1 : p.t0,
      s = Math.sign(p.t1 - p.t0);
    return [-Math.sin(a) * s, Math.cos(a) * s];
  };
  const R = (p: [number, number]): Vec3 => [p[0] * Math.cos(rot) - p[1] * Math.sin(rot), p[0] * Math.sin(rot) + p[1] * Math.cos(rot), z];
  const Rd = (d: [number, number]): Vec3 => [d[0] * Math.cos(rot) - d[1] * Math.sin(rot), d[0] * Math.sin(rot) + d[1] * Math.cos(rot), 0];
  const out = pts.map(R);
  // exact end points: the flanks' own (identical up to rounding)
  out[0] = [first[0], first[1], z];
  out[out.length - 1] = [last[0], last[1], z];
  return { kind: "spline", pts: out, t0: Rd(dir(pieces[0], false)), t1: Rd(dir(pieces[pieces.length - 1], true)) };
}

/** The closed transverse profile, counterclockwise: per tooth flankL (up), tip, flankR (down), root. */
function profile(g: Geo, phase: number, z: number): GearProfileEdge[] {
  const { N, rlo, ra } = g;
  const out: GearProfileEdge[] = [];
  const P = (p: [number, number]): Vec3 => [p[0], p[1], z];
  const tb = Math.sqrt(Math.max(0, (rlo / g.rb) ** 2 - 1)),
    tt = Math.sqrt((ra / g.rb) ** 2 - 1);
  // radii evenly spaced in roll angle (denser near the base circle, where the involute bends most)
  const radii = Array.from({ length: 13 }, (_, i) => g.rb * Math.sqrt(1 + (tb + ((tt - tb) * i) / 12) ** 2));
  radii[0] = rlo;
  radii[12] = ra;
  const tangent = (r: number, c: number, side: number, dir: number): Vec3 => {
    const h = 1e-5 * g.m;
    const a = flankPoint(g, Math.max(rlo, r - h), c, side),
      b = flankPoint(g, Math.min(ra, r + h), c, side);
    return [dir * (b[0] - a[0]), dir * (b[1] - a[1]), 0];
  };
  for (let k = 0; k < N; k++) {
    const c = phase + (2 * Math.PI * k) / N;
    out.push({ kind: "spline", pts: radii.map((r) => P(flankPoint(g, r, c, -1))), t0: tangent(rlo, c, -1, 1), t1: tangent(ra, c, -1, 1) });
    const pt = psi(g, ra);
    out.push({ kind: "arc", a: P([ra * Math.cos(c - pt), ra * Math.sin(c - pt)]), mid: P([ra * Math.cos(c), ra * Math.sin(c)]), b: P([ra * Math.cos(c + pt), ra * Math.sin(c + pt)]) });
    out.push({ kind: "spline", pts: [...radii].reverse().map((r) => P(flankPoint(g, r, c, 1))), t0: tangent(ra, c, 1, -1), t1: tangent(rlo, c, 1, -1) });
    const next = c + (2 * Math.PI) / N;
    const rootStart = g.root[0].kind === "line" ? g.rb : rlo;
    out.push(compositeCurve(g.root, c + Math.PI / N, z, flankPoint(g, rootStart, c, 1), flankPoint(g, rootStart, next, -1)));
  }
  return out;
}

/**
 * An involute gear about the Z axis, from z = 0 to `width`: spur, helical (`helix`) or herringbone
 * (`helix` + `herringbone`), built in one step (no unions) with exact involute flanks.
 *
 * Faces: `<tag> · tooth<k> · flankL` / `flankR` (left/right seen from outside, Z up; a herringbone
 * adds `· front` (above the apex) or `· rear`), `<tag> · tip<k>`, `<tag> · root<k>` (the gap after
 * tooth k), `<tag> · face.start` (z = 0), `face.end`, `bore`. Tooth 0 is centred on `phase`.
 * Connectors: `axis` (Z through the origin) and `pitch` (on the pitch circle at tooth 0, x outward).
 *
 * Meshing: place gears `gear.centerDistance(a, b)` apart along a line at `angle`, and build b with
 * `phase: gear.meshPhase(a, b, angle)`; phases are measured at z = 0 (the apex), so line those up.
 * @example gear({ teeth: 24, module: 2, width: 10, bore: 8, tag: "pinion" })
 * @example gear({ teeth: 40, module: 1.5, width: 12, helix: 30, herringbone: true, tag: "drive" })
 */
export function gear(opts: GearOpts): Solid {
  if (!opts || typeof opts !== "object") userError("gear(opts) needs { teeth, module, width }");
  const known = ["teeth", "module", "width", "pressureAngle", "helix", "herringbone", "backlash", "profileShift", "rootFillet", "tipRelief", "bore", "phase", "internal", "allowUndercut", "tag"];
  for (const k of Object.keys(opts)) if (!known.includes(k)) userError(`gear has no option "${k}"; use ${known.join(", ")}`);
  const teeth = int(opts.teeth, "gear teeth", 3);
  const module = positive(opts.module, "gear module");
  const width = positive(opts.width, "gear width");
  const pressureAngle = num(opts.pressureAngle ?? 20, "gear pressureAngle");
  if (!(pressureAngle > 0 && pressureAngle < 45)) userError(`gear pressureAngle must be between 0 and 45° (got ${pressureAngle})`);
  const helix = num(opts.helix ?? 0, "gear helix");
  if (!(Math.abs(helix) < 75)) userError(`gear helix must be between −75 and 75° (got ${helix})`);
  const backlash = nonNegative(opts.backlash ?? 0, "gear backlash");
  const profileShift = num(opts.profileShift ?? 0, "gear profileShift");
  const rootFillet = nonNegative(opts.rootFillet ?? 0.38, "gear rootFillet");
  const tipRelief = nonNegative(opts.tipRelief ?? 0, "gear tipRelief");
  const bore = opts.bore === undefined ? undefined : positive(opts.bore, "gear bore");
  const phase = num(opts.phase ?? 0, "gear phase");
  if (opts.internal) userError("gear: internal (ring) gears aren't supported yet");
  let apex: number | undefined;
  if (opts.herringbone) {
    if (!helix) userError("gear: a herringbone needs a helix angle (e.g. helix: 30)");
    apex = opts.herringbone === true ? width / 2 : num((opts.herringbone as { apex: number }).apex, "gear herringbone apex");
    if (!(apex > 0 && apex < width)) userError(`gear: the herringbone apex (z = ${apex}) must lie inside the face width (0..${width})`);
  }
  const g = geometry({ teeth, module, pressureAngle, backlash, profileShift, rootFillet, tipRelief, allowUndercut: !!opts.allowUndercut, bore });
  const zRef = apex ?? 0;
  const twist = helix ? Math.tan(helix * DEG) / g.rp : 0; // rad per mm along +Z (+: counterclockwise)
  const ph = phase * DEG;
  const rec = runOp({
    type: "gear",
    tag: opts.tag,
    params: { teeth, module, width, pressureAngle, helix, apex, backlash, profileShift, rootFillet, tipRelief, bore, phase },
    inputs: [],
    build: () => ({
      built: gearBody({ edges: profile(g, ph, zRef), width, zProfile: zRef, twist, herringbone: apex !== undefined, bore }),
      roles: ({ topo }) => ({ face: topo.faces.items.map((f: unknown) => faceRole(g, f, { width, apex, twist, phase: ph, bore })) }),
    }),
  });
  const info: GearInfo = { teeth, module, pressureAngle, helix, profileShift, phase, pitchRadius: g.rp, tipRadius: g.ra, rootRadius: g.rf, zReference: zRef };
  const pitch = { origin: [g.rp * Math.cos(ph), g.rp * Math.sin(ph), zRef] as Vec3, z: [0, 0, 1] as Vec3, x: [Math.cos(ph), Math.sin(ph), 0] as Vec3 };
  return new Solid(rec, { connectors: { axis: [{ origin: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] }], pitch: [pitch] }, gear: info });
}

/** Name a gear face from where it is: radius, angle with the twist taken out, z. */
function faceRole(g: Geo, face: unknown, o: { width: number; apex?: number; twist: number; phase: number; bore?: number }): string {
  const { point: p, normal, planar } = faceSample(face);
  const tol = 1e-4 * Math.max(1, g.m);
  if (planar && Math.abs(Math.abs(normal[2]) - 1) < 1e-6) return Math.abs(p[2]) < tol ? "face.start" : Math.abs(p[2] - o.width) < tol ? "face.end" : "face";
  const r = Math.hypot(p[0], p[1]);
  if (o.bore !== undefined && Math.abs(r - o.bore / 2) < tol) return "bore";
  const zRef = o.apex ?? 0;
  const turned = o.twist * (o.apex === undefined ? p[2] - zRef : Math.abs(p[2] - zRef));
  const pitch = (2 * Math.PI) / g.N;
  const u = Math.atan2(p[1], p[0]) - o.phase - turned;
  const arm = o.apex === undefined ? "" : p[2] > o.apex ? " · front" : " · rear";
  const mod = (k: number) => ((k % g.N) + g.N) % g.N;
  if (r < g.rlo - 1e-3 * g.m) return `root${mod(Math.floor(u / pitch))}${arm}`;
  const k = Math.round(u / pitch);
  if (r > g.ra - 1e-3 * g.m) return `tip${mod(k)}${arm}`;
  return `tooth${mod(k)} · ${u - k * pitch < 0 ? "flankL" : "flankR"}${arm}`;
}

function infoOf(x: GearLike, what: string): Pick<GearInfo, "teeth" | "module" | "pressureAngle" | "profileShift" | "phase" | "helix"> {
  if (x instanceof Solid) {
    const i = x.meta.gear;
    if (!i) userError(`${what}: this solid isn't a gear (made by gear(...))`);
    return i;
  }
  if (!x || typeof x !== "object") userError(`${what}: expected a gear solid or { teeth, module }`);
  const o = x as GearInfo;
  return {
    teeth: int(o.teeth, `${what} teeth`, 3),
    module: positive(o.module, `${what} module`),
    pressureAngle: num(o.pressureAngle ?? 20, `${what} pressureAngle`),
    profileShift: num(o.profileShift ?? 0, `${what} profileShift`),
    phase: num(o.phase ?? 0, `${what} phase`),
    helix: num(o.helix ?? 0, `${what} helix`),
  };
}

/**
 * Centre distance (mm) of two external gears in mesh: `module × (teeth_a + teeth_b) / 2`, and with
 * profile shift the operating distance at which both run without backlash. Takes gear solids or
 * their options.
 */
gear.centerDistance = function centerDistance(a: GearLike, b: GearLike): number {
  const A = infoOf(a, "gear.centerDistance a"),
    B = infoOf(b, "gear.centerDistance b");
  if (Math.abs(A.module - B.module) > 1e-9) userError(`gear.centerDistance: the gears have different modules (${A.module} and ${B.module}) and can't mesh`);
  if (Math.abs(A.pressureAngle - B.pressureAngle) > 1e-9) userError(`gear.centerDistance: the gears have different pressure angles (${A.pressureAngle}° and ${B.pressureAngle}°)`);
  if (Math.abs(A.helix + B.helix) > 1e-9) warn(`gear.centerDistance: external helical gears mesh with equal and opposite helix angles (got ${A.helix}° and ${B.helix}°)`, "operation");
  const alpha = A.pressureAngle * DEG,
    n = A.teeth + B.teeth;
  const a0 = (A.module * n) / 2;
  const xs = A.profileShift + B.profileShift;
  if (!xs) return a0;
  // operating pressure angle: inv αw = inv α + 2 (x1 + x2) tan α / (z1 + z2)
  const target = inv(alpha) + (2 * xs * Math.tan(alpha)) / n;
  let lo = 1e-6,
    hi = Math.PI / 2 - 1e-6;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (inv(mid) < target) lo = mid;
    else hi = mid;
  }
  return (a0 * Math.cos(alpha)) / Math.cos((lo + hi) / 2);
};

/**
 * The `phase` (degrees) for gear b so its teeth sit in gear a's gaps, with b's centre placed from
 * a's along the line of centres at `angle` degrees (about Z, from +X). Both phases are measured at
 * the gears' reference planes (z = 0, or a herringbone's apex), which must line up.
 * @example
 * const a = gear({ teeth: 30, module: 2, width: 8, phase: 5, tag: "a" })
 * const d = gear.centerDistance(a, { teeth: 18, module: 2 }), ang = 40
 * const b = gear({ teeth: 18, module: 2, width: 8, phase: gear.meshPhase(a, { teeth: 18, module: 2 }, ang), tag: "b" })
 *   .translate([d * Math.cos(ang * Math.PI / 180), d * Math.sin(ang * Math.PI / 180), 0])
 */
gear.meshPhase = function meshPhase(a: GearLike, b: GearLike, angle: number): number {
  const A = infoOf(a, "gear.meshPhase a"),
    B = infoOf(b, "gear.meshPhase b");
  num(angle, "gear.meshPhase angle");
  // a's pitch point on the line of centres rolls onto b's (reversed); a tooth there meets a gap
  const p = angle + 180 + 180 / B.teeth - (A.teeth / B.teeth) * (A.phase - angle);
  const step = 360 / B.teeth;
  const r = ((p % step) + step) % step;
  return Math.abs(r - step) < 1e-9 ? 0 : r;
};
