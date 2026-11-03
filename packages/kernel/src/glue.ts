// Fast glue union for solids that only touch: imprint just the coincident faces, then rebuild.
//
// OCCT's glue modes still intersect every edge with every face whose bounding box it meets; on a
// gear (hundreds of B-spline tooth edges standing on its end faces) that is seconds. Here the touching
// faces are found by their surfaces (same plane / same cylinder, from different inputs), split
// against each other by a general fuse of only those faces, the pieces covered from both sides
// dropped, and the result sewn back together with the untouched faces and simplified like a boolean
// (same-domain faces merged), with a history equivalent to the fuse's. The caller validates the
// result (volume, validity) as for any glue.
import { oc } from "./oc";
import { tmp, scoped } from "./memory";
import { downcast, explore, listToArray, hashShape, type Shape } from "./topo";
import { type Vec3 } from "./geom";
import { KernelError, BOOLEAN_FUZZY, compound, type Built } from "./ops";

type Surf =
  | { kind: "plane"; n: Vec3; d: number }
  | { kind: "cylinder"; a: Vec3; p: Vec3; r: number }
  | { kind: "sphere"; c: Vec3; r: number }
  /** anything else (cone, torus, B-spline, extrusion...): not imprinted here (gp_Cone isn't bound in this build) */
  | { kind: "free" };
type FaceRef = { input: number; face: Shape; surf: Surf; box: number[]; sign: number };

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const LIN = 1e-5;
const ANG = 1e-9;

/** Canonical direction (first non-zero component positive) and whether it was flipped. */
function canon(d: Vec3): [Vec3, number] {
  const s = Math.abs(d[0]) > ANG ? Math.sign(d[0]) : Math.abs(d[1]) > ANG ? Math.sign(d[1]) : Math.sign(d[2]);
  return [[d[0] * s, d[1] * s, d[2] * s], s];
}

/** The surface a face lies on, and which way the face's outward normal points relative to it (+1 / −1). */
function surfaceOf(face: Shape): { surf: Surf; sign: number } {
  const O = oc();
  return scoped(() => {
    const ad = tmp(new O.BRepAdaptor_Surface(face, true));
    const T = O.GeomAbs_SurfaceType;
    const t = ad.GetType();
    const rev = face.Orientation() === O.TopAbs_Orientation.TopAbs_REVERSED ? -1 : 1;
    const v3 = (p: any): Vec3 => [p.X(), p.Y(), p.Z()];
    if (t === T.GeomAbs_Plane) {
      const pl = tmp(ad.Plane());
      const ax = tmp(pl.Axis());
      const [n, s] = canon(v3(tmp(ax.Direction())));
      return { surf: { kind: "plane", n, d: dot(n, v3(tmp(ax.Location()))) }, sign: s * rev * (pl.Direct() ? 1 : -1) };
    }
    if (t === T.GeomAbs_Cylinder) {
      const c = tmp(ad.Cylinder());
      const ax = tmp(c.Axis());
      const [a] = canon(v3(tmp(ax.Direction())));
      const o = v3(tmp(ax.Location()));
      const k = dot(o, a);
      // outward (away from the axis) for a forward face on a direct cylinder
      return { surf: { kind: "cylinder", a, p: [o[0] - k * a[0], o[1] - k * a[1], o[2] - k * a[2]], r: c.Radius() }, sign: rev * (c.Direct() ? 1 : -1) };
    }
    if (t === T.GeomAbs_Sphere) {
      const c: any = tmp(ad.Sphere());
      return { surf: { kind: "sphere", c: v3(tmp(c.Location())), r: c.Radius() }, sign: rev * (c.Direct() ? 1 : -1) };
    }
    return { surf: { kind: "free" }, sign: rev };
  });
}

function sameSurface(a: Surf, b: Surf): boolean {
  if (a.kind === "plane" && b.kind === "plane") return 1 - dot(a.n, b.n) < ANG && Math.abs(a.d - b.d) < LIN;
  const near = (p: Vec3, q: Vec3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < LIN;
  if (a.kind === "cylinder" && b.kind === "cylinder") return 1 - dot(a.a, b.a) < ANG && Math.abs(a.r - b.r) < LIN && near(a.p, b.p);
  if (a.kind === "sphere" && b.kind === "sphere") return Math.abs(a.r - b.r) < LIN && near(a.c, b.c);
  return false;
}

function bbox(face: Shape): number[] {
  const O = oc();
  return scoped(() => {
    const b = tmp(new O.Bnd_Box());
    O.BRepBndLib.Add(face, b, false);
    const lo = tmp(b.CornerMin()),
      hi = tmp(b.CornerMax());
    const e = BOOLEAN_FUZZY;
    return [lo.X() - e, lo.Y() - e, lo.Z() - e, hi.X() + e, hi.Y() + e, hi.Z() + e];
  });
}
const boxesMeet = (a: number[], b: number[]) => a[0] <= b[3] && b[0] <= a[3] && a[1] <= b[4] && b[1] <= a[4] && a[2] <= b[5] && b[2] <= a[5];

/** Shape-keyed map (IsSame). */
class ShapeMap<V> {
  /** explored shape lists the keys and values come from, deleted with whoever keeps the map */
  owned: { delete(): void }[] = [];
  private m = new Map<number, { k: Shape; v: V }[]>();
  get(k: Shape): V | undefined {
    return this.m.get(hashShape(k))?.find((x) => x.k.IsSame(k))?.v;
  }
  set(k: Shape, v: V) {
    const h = hashShape(k);
    const b = this.m.get(h) ?? [];
    const e = b.find((x) => x.k.IsSame(k));
    if (e) e.v = v;
    else b.push({ k, v });
    this.m.set(h, b);
  }
  has(k: Shape) {
    return this.get(k) !== undefined;
  }
  values() {
    return [...this.m.values()].flatMap((b) => b.map((x) => x.v));
  }
}

/**
 * Union of solids that only touch, built by imprinting the coincident faces. Throws a KernelError
 * saying why when this way doesn't apply (no coincident plane/cylinder faces, faces facing the same
 * way, the pieces don't close up); the caller then uses OCCT's glue.
 */
export function glueSewn(a: Shape, tools: Shape[]): Built {
  const O = oc();
  const inputs = [a, ...tools];
  // 1. faces on planes and cylinders, per input
  const refs: FaceRef[] = [];
  const faceLists = inputs.map((s) => explore(s, "face"));
  const free: FaceRef[] = [];
  faceLists.forEach((fs, input) => {
    for (const face of fs.items) {
      const s = surfaceOf(face);
      (s.surf.kind === "free" ? free : refs).push({ input, face, surf: s.surf, box: [], sign: s.sign });
    }
  });
  // free-form faces can't be imprinted here: if two of them coincide, leave it to OCCT's glue
  if (freeFormContact(free)) throw new KernelError("free-form faces touch (only planes, cylinders and spheres are imprinted here)");
  // 2. groups: same surface, different inputs, boxes meeting
  const up = refs.map((_, i) => i);
  const root = (i: number): number => (up[i] === i ? i : (up[i] = root(up[i])));
  const boxOf = (r: FaceRef) => (r.box.length ? r.box : (r.box = bbox(r.face)));
  const linked = new Set<number>();
  for (let i = 0; i < refs.length; i++)
    for (let j = i + 1; j < refs.length; j++) {
      if (refs[i].input === refs[j].input || !sameSurface(refs[i].surf, refs[j].surf)) continue;
      if (!boxesMeet(boxOf(refs[i]), boxOf(refs[j]))) continue;
      up[root(i)] = root(j);
      linked.add(i).add(j);
    }
  const groups = new Map<number, number[]>();
  for (const i of linked) groups.set(root(i), [...(groups.get(root(i)) ?? []), i]);
  if (!groups.size) throw new KernelError("no coincident faces");
  // 3. split each group's faces against each other
  const makers: any[] = [];
  /** input sub-shape -> its images (group faces, their edges and vertices) */
  const images = new ShapeMap<Shape[]>();
  const dropped: Shape[] = [];
  const kept: Shape[] = [];
  /** some group keeps pieces of two inputs facing the same way: they may merge into one face */
  let mergeable = false;
  const grouped = new ShapeMap<true>();
  try {
    for (const members of groups.values()) {
      const gf = new O.BRepAlgoAPI_BuilderAlgo();
      makers.push(gf);
      const args = tmp(new O.NCollection_List_TopoDS_Shape());
      for (const i of members) args.Append(refs[i].face);
      gf.SetArguments(args);
      gf.SetFuzzyValue(BOOLEAN_FUZZY);
      gf.SetNonDestructive(true);
      gf.Build(tmp(new O.Message_ProgressRange()));
      if (!gf.IsDone() || gf.HasErrors()) throw new KernelError("imprinting the touching faces failed");
      // owners of every piece: which way each owner faces through it
      const owners = new ShapeMap<{ piece: Shape; dirs: { input: number; sign: number }[] }>();
      for (const i of members) {
        const r = refs[i];
        grouped.set(r.face, true);
        const mods = listToArray(gf.Modified(r.face));
        const pieces = mods.length ? mods : [r.face];
        images.set(r.face, pieces);
        for (const p of pieces) {
          const o = owners.get(p) ?? { piece: p, dirs: [] };
          o.dirs.push({ input: r.input, sign: r.sign });
          owners.set(p, o);
        }
        for (const kind of ["edge", "vertex"] as const) {
          const subs = explore(r.face, kind);
          for (const e of subs.items) {
            if (images.has(e)) continue;
            const m = listToArray(gf.Modified(e));
            if (m.length) images.set(e, m);
          }
        }
      }
      const keptBy = new Set<string>();
      for (const o of owners.values()) {
        if (o.dirs.length === 1) {
          keptBy.add(`${o.dirs[0].input}:${o.dirs[0].sign}`);
          // keep it facing like its owner
          const ps = surfaceOf(o.piece)?.sign ?? o.dirs[0].sign;
          kept.push(ps !== o.dirs[0].sign ? downcast(o.piece.Reversed()) : o.piece);
          continue;
        }
        const ins = new Set(o.dirs.map((d) => d.input));
        if (o.dirs.length > 2 || ins.size < o.dirs.length) throw new KernelError("more than two faces coincide");
        if (o.dirs[0].sign === o.dirs[1].sign) throw new KernelError("inputs overlap (coincident faces facing the same way)");
        dropped.push(o.piece);
      }
      const signs = [...keptBy].map((k) => k.split(":")[1]);
      if (new Set(signs).size < signs.length) mergeable = true;
    }
    // 4. faces outside the groups whose edges or vertices the imprint replaced need re-sewing
    const others: Shape[] = [];
    const touched: Shape[] = [];
    for (const fs of faceLists)
      for (const f of fs.items) {
        if (grouped.has(f)) continue;
        let hit = false;
        for (const kind of ["edge", "vertex"] as const) {
          if (hit) break;
          const subs = explore(f, kind);
          hit = subs.items.some((e) => images.has(e));
          subs.delete();
        }
        (hit ? touched : others).push(f);
      }
    const sew = tmp(new O.BRepBuilderAPI_Sewing(BOOLEAN_FUZZY, true, true, true, false));
    sew.Load(compound([...others, ...touched, ...kept]));
    for (const f of [...touched, ...kept]) sew.Add(f);
    sew.Perform(tmp(new O.Message_ProgressRange()));
    // an edge shared by more than two faces: faces that coincide but weren't imprinted
    if (sew.NbMultipleEdges() > 0) throw new KernelError("faces meet along edges shared by more than two faces");
    const sewn = downcast(sew.SewedShape());
    // 5. closed shells -> solids
    const shells = explore(sewn, "shell");
    if (!shells.items.length) throw new KernelError("the pieces don't sew into a shell");
    const b = tmp(new O.TopoDS_Builder());
    const out = new O.TopoDS_Compound();
    b.MakeCompound(out);
    for (const sh of shells.items) {
      if (!O.BRep_Tool.IsClosed(sh)) throw new KernelError("the touching faces leave the result open");
      const so = new O.TopoDS_Solid();
      b.MakeSolid(so);
      b.Add(so, sh);
      b.Add(out, so);
    }
    // free faces (not in any shell) mean the pieces didn't join
    const loose = explore(sewn, "face").items.length - shells.items.reduce((n, sh) => n + explore(sh, "face").items.length, 0);
    if (loose) throw new KernelError("some faces didn't join the result");
    const solids = explore(out, "solid").items;
    // separate solids that still touch: a contact this way didn't see
    const sb = solids.map((x) => bbox(x));
    for (let i = 0; i < sb.length; i++) for (let j = i + 1; j < sb.length; j++) if (boxesMeet(sb[i], sb[j])) throw new KernelError("the result has separate solids that may touch");
    const assembled = solids.length === 1 ? solids[0] : out;
    // where the sewing put each face, edge and vertex it was given
    const sewMap = follow(compound([...others, ...touched, ...kept]), assembled);
    // the maps hold the explored faces: the history owns them from here
    const owned = [...faceLists, ...sewMap.owned];
    if (!mergeable) {
      faceLists.length = 0;
      return { shape: assembled, maker: new GlueHistory(images, dropped, sewMap, null, makers, owned) };
    }
    // 6. simplify like a boolean: merge same-domain neighbours (UnifySameDomain, history rebuilt from geometry)
    const { shape, map } = unify(assembled);
    faceLists.length = 0;
    return { shape, maker: new GlueHistory(images, dropped, sewMap, map, makers, [...owned, ...map.owned]) };
  } catch (e) {
    for (const m of makers) m.delete?.();
    throw e;
  } finally {
    for (const fs of faceLists) fs.delete();
  }
}

/**
 * History of a sewn glue: input entity -> imprint images (and itself) -> where sewing put it -> where
 * the simplify put that. Dropped pieces (the touching parts) have no images.
 */
class GlueHistory {
  constructor(
    private images: ShapeMap<Shape[]>,
    private dropped: Shape[],
    private sewn: ShapeMap<Shape[]>,
    private unified: ShapeMap<Shape[]> | null,
    private makers: any[],
    private owned: { delete(): void }[],
  ) {}
  /**
   * Where `s` may have gone: its imprint images and itself (an edge of a dropped contact face lives
   * on as its sewn copy), each followed through sewing and simplifying. Entities not in the output
   * are harmless: history collection only indexes output entities.
   */
  private chain(s: Shape): Shape[] {
    const out: Shape[] = [];
    for (const x of [...(this.images.get(s) ?? []), s]) {
      if (this.dropped.some((d) => d.IsSame(x))) continue;
      for (const y of this.sewn.get(x) ?? [x]) out.push(...(this.unified?.get(y) ?? [y]));
    }
    return out;
  }
  Modified(s: Shape) {
    const l = new (oc().NCollection_List_TopoDS_Shape)();
    // the input itself surviving is "same" (found directly), not modified
    for (const x of this.chain(s)) if (!x.IsSame(s)) l.Append(x);
    return l;
  }
  Generated(_s: Shape) {
    return new (oc().NCollection_List_TopoDS_Shape)();
  }
  IsDeleted(_s: Shape) {
    return false;
  }
  delete() {
    for (const m of this.makers) m.delete?.();
    for (const o of this.owned) o.delete();
  }
}

/**
 * The glue promise, checked before any glue: does any input reach inside another? Neither a sewn
 * result nor OCCT's glue modes (which skip face/face intersection) notice an overlap: both come out
 * with the inputs' total volume. Two checks, cheap first:
 * - points: samples each input (vertices, points along edges) and classifies those inside another input's bounding box against that solid: inside,
 * and not on its boundary (touching), means the inputs overlap. Returns what was found, or null.
 */
export function glueOverlap(inputs: Shape[]): string | null {
  return pointInside(inputs) ?? facesCross(inputs);
}

function pointInside(inputs: Shape[]): string | null {
  const O = oc();
  const boxes = inputs.map((s) => bbox(s));
  const shrink = 1e-3;
  const within = (b: number[], p: Vec3) => p[0] > b[0] + shrink && p[0] < b[3] - shrink && p[1] > b[1] + shrink && p[1] < b[4] - shrink && p[2] > b[2] + shrink && p[2] < b[5] - shrink;
  for (let j = 0; j < inputs.length; j++) {
    const others = inputs.map((_, i) => i).filter((i) => i !== j && boxesMeet(boxes[i], boxes[j]));
    if (!others.length) continue;
    for (const p of samples(inputs[j])) {
      for (const i of others) {
        if (!within(boxes[i], p)) continue;
        const hit = scoped(() => {
          const v = tmp(new O.BRepBuilderAPI_MakeVertex(tmp(new O.gp_Pnt(p[0], p[1], p[2])))).Vertex();
          // InnerSolution only answers for a solid, not a compound holding one
          const solids = explore(inputs[i], "solid");
          solids.items.forEach((x) => tmp(x));
          const within = solids.items.some((so) => {
            const d = tmp(new O.BRepExtrema_DistShapeShape(v, so));
            return d.IsDone() && d.InnerSolution();
          });
          if (!within) return false;
          // inside the solid: is it on the boundary (touching) or truly within?
          const shells = explore(inputs[i], "shell");
          shells.items.forEach((x) => tmp(x));
          return shells.items.every((sh) => {
            const b = tmp(new O.BRepExtrema_DistShapeShape(v, sh));
            return b.IsDone() && b.Value() > 10 * BOOLEAN_FUZZY;
          });
        });
        if (hit) return `a point of input ${j + 1} at (${p.map((c) => +c.toFixed(3)).join(", ")}) lies inside input ${i + 1}`;
      }
    }
  }
  return null;
}

/**
 * Sample points of a solid: its vertices and points at a quarter, half and three quarters along each
 * edge. (Not points inside faces: a face's parameter range covers its holes too.)
 */
function samples(s: Shape): Vec3[] {
  const O = oc();
  return scoped(() => {
    const out: Vec3[] = [];
    const vs = explore(s, "vertex");
    for (const v of vs.items) {
      const p = tmp(O.BRep_Tool.Pnt(O.TopoDS.Vertex(v)));
      out.push([p.X(), p.Y(), p.Z()]);
    }
    vs.delete();
    const es = explore(s, "edge");
    for (const e of es.items) {
      const c = tmp(new O.BRepAdaptor_Curve(O.TopoDS.Edge(e)));
      const a = c.FirstParameter(),
        b = c.LastParameter();
      for (const t of [0.25, 0.5, 0.75]) {
        const p = tmp(c.Value(a + (b - a) * t));
        out.push([p.X(), p.Y(), p.Z()]);
      }
    }
    es.delete();
    return out;
  });
}

/**
 * ShapeUpgrade_UnifySameDomain (as a boolean's SimplifyResult does), with its history rebuilt from
 * geometry (this build doesn't expose it): see `follow`.
 */
function unify(shape: Shape): { shape: Shape; map: ShapeMap<Shape[]> } {
  const O = oc();
  const usd = tmp(new O.ShapeUpgrade_UnifySameDomain(shape, true, true, false));
  usd.Build();
  const out = downcast(usd.Shape());
  return { shape: out, map: follow(shape, out) };
}

/**
 * Where the entities of `pre` went in `post`, for rebuilds that keep geometry (sewing, unifying
 * same-domain faces): an entity still in `post` is itself (not in the map); one that disappeared
 * maps to the new entity of the same kind and surface / curve type whose box contains it, the
 * smallest such (a face re-bounded by sewing has the same box; merged faces and edges contain their
 * parts); a vertex to a new vertex at the same point, else nothing (merged away).
 */
function follow(pre: Shape, post: Shape): ShapeMap<Shape[]> {
  const O = oc();
  const map = new ShapeMap<Shape[]>();
  const contains = (big: number[], small: number[]) => small[0] >= big[0] - LIN && small[1] >= big[1] - LIN && small[2] >= big[2] - LIN && small[3] <= big[3] + LIN && small[4] <= big[4] + LIN && small[5] <= big[5] + LIN;
  const size = (b: number[]) => b[3] - b[0] + b[4] - b[1] + b[5] - b[2];
  const typeOf = (x: Shape, kind: "face" | "edge") =>
    scoped(() => (kind === "face" ? tmp(new O.BRepAdaptor_Surface(x, true)).GetType() : tmp(new O.BRepAdaptor_Curve(O.TopoDS.Edge(x))).GetType()));
  const pt = (v: Shape) =>
    scoped(() => {
      const p = tmp(O.BRep_Tool.Pnt(O.TopoDS.Vertex(v)));
      return [p.X(), p.Y(), p.Z()];
    });
  for (const kind of ["face", "edge", "vertex"] as const) {
    const a = explore(pre, kind),
      b = explore(post, kind);
    map.owned.push(a, b);
    const gone = a.items.filter((x) => b.indexOf(x) < 0);
    const fresh = b.items.filter((x) => a.indexOf(x) < 0);
    if (!gone.length) continue;
    if (kind === "vertex") {
      const fp = fresh.map(pt);
      for (const g of gone) {
        const q = pt(g);
        const i = fp.findIndex((p) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 10 * BOOLEAN_FUZZY);
        map.set(g, i >= 0 ? [fresh[i]] : []);
      }
      continue;
    }
    const fb = fresh.map((x) => ({ x, b: bbox(x), t: typeOf(x, kind), s: kind === "face" ? surfaceOf(x).surf : undefined }));
    for (const g of gone) {
      const gb = bbox(g),
        gt = typeOf(g, kind),
        gs = kind === "face" ? surfaceOf(g).surf : undefined;
      const c = fb.filter((f) => f.t === gt && contains(f.b, gb) && (!gs || !f.s || gs.kind === "free" || sameSurface(gs, f.s))).sort((p, q) => size(p.b) - size(q.b))[0];
      map.set(g, c ? [c.x] : []);
    }
  }
  return map;
}

/**
 * Do two free-form faces of different inputs coincide anywhere? Points on a 3 × 3 grid of each face
 * that fall in the other's box are projected onto the other's surface; one lying on it counts.
 * (Conservative: a grid point in a face's hole can also count, which only costs the fast path.)
 */
function freeFormContact(free: FaceRef[]): boolean {
  const O = oc();
  if (free.length < 2 || new Set(free.map((f) => f.input)).size < 2) return false;
  for (const f of free) f.box = bbox(f.face);
  const grid = (f: FaceRef): Vec3[] =>
    scoped(() => {
      const ad = tmp(new O.BRepAdaptor_Surface(f.face, true));
      const b = O.BRepTools.UVBounds(f.face, 0, 0, 0, 0);
      const out: Vec3[] = [];
      for (const u of [0.25, 0.5, 0.75])
        for (const w of [0.25, 0.5, 0.75]) {
          const p = tmp(ad.Value(b.UMin + (b.UMax - b.UMin) * u, b.VMin + (b.VMax - b.VMin) * w));
          out.push([p.X(), p.Y(), p.Z()]);
        }
      return out;
    });
  const inBox = (b: number[], p: Vec3) => p[0] >= b[0] && p[0] <= b[3] && p[1] >= b[1] && p[1] <= b[4] && p[2] >= b[2] && p[2] <= b[5];
  for (let i = 0; i < free.length; i++) {
    let pts: Vec3[] | null = null;
    for (let j = 0; j < free.length; j++) {
      if (free[i].input === free[j].input || !boxesMeet(free[i].box, free[j].box)) continue;
      pts ??= grid(free[i]);
      const hit = pts.some(
        (p) =>
          inBox(free[j].box, p) &&
          scoped(() => {
            const surf = O.BRep_Tool.Surface(O.TopoDS.Face(free[j].face));
            const pr = tmp(new O.GeomAPI_ProjectPointOnSurf(tmp(new O.gp_Pnt(p[0], p[1], p[2])), surf));
            return pr.NbPoints() > 0 && pr.LowerDistance() < LIN * 10;
          }),
      );
      if (hit) return true;
    }
  }
  return false;
}

/**
 * Do faces of different inputs cut through each other? Only pairs whose boxes overlap with real
 * thickness and that don't lie on one surface (those are imprinted contacts) are intersected; faces
 * that merely touch (a gear's teeth standing on a hub's face) have boxes meeting in a plane and cost
 * nothing. An intersection curve through the interior of both faces means they cross; one along a
 * face's boundary is that face's edge resting on the other (touching), and an overlap still has
 * crossing curves elsewhere around it.
 */
function facesCross(inputs: Shape[]): string | null {
  const O = oc();
  const T = 1e-3;
  const lists = inputs.map((s) => explore(s, "face"));
  try {
    const faces = lists.flatMap((l, input) => l.items.map((face) => ({ input, face, box: bbox(face), surf: null as Surf | null })));
    const thick = (a: number[], b: number[]) => [0, 1, 2].every((k) => Math.min(a[k + 3], b[k + 3]) - Math.max(a[k], b[k]) > 2 * BOOLEAN_FUZZY + T);
    const surf = (f: (typeof faces)[number]) => (f.surf ??= surfaceOf(f.face).surf);
    for (let i = 0; i < faces.length; i++)
      for (let j = i + 1; j < faces.length; j++) {
        const a = faces[i],
          b = faces[j];
        if (a.input === b.input || !thick(a.box, b.box)) continue;
        const sa = surf(a),
          sb = surf(b);
        if (sa.kind !== "free" && sameSurface(sa, sb)) continue;
        const hit = scoped(() => {
          const sec = tmp(new O.BRepAlgoAPI_Section(a.face, b.face, true));
          if (!sec.IsDone()) return true;
          const edges = explore(sec.Shape(), "edge");
          edges.items.forEach((e) => tmp(e));
          if (!edges.items.length) return false;
          const rim = (f: Shape) => {
            const es = explore(f, "edge");
            es.items.forEach((e) => tmp(e));
            return compound(es.items);
          };
          const ra = tmp(rim(a.face)),
            rb = tmp(rim(b.face));
          return edges.items.some((e) => {
            const c = tmp(new O.BRepAdaptor_Curve(O.TopoDS.Edge(e)));
            const p = tmp(c.Value((c.FirstParameter() + c.LastParameter()) / 2));
            const v = tmp(new O.BRepBuilderAPI_MakeVertex(p)).Vertex();
            const off = (r: Shape) => tmp(new O.BRepExtrema_DistShapeShape(v, r)).Value() > T;
            return off(ra) && off(rb);
          });
        });
        if (hit) return `faces of inputs ${a.input + 1} and ${b.input + 1} cut through each other`;
      }
    return null;
  } finally {
    for (const l of lists) l.delete();
  }
}
