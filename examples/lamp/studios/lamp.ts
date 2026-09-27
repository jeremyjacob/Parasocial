import { part, param, sketch, cylinder, plane, mm, type P2, type Solid } from "parasocial";

export const name = "Lamp";

// An articulated desk lamp. Two parallelogram linkages (an arm plus a thinner rod, pinned to
// knuckles at both ends) keep the elbow knuckle and the wrist level wherever the arms go, so
// the shade keeps pointing where it was aimed. Every part is modeled in place at its home pose;
// studios/mechanism.ts joins them (drag the arms, the shade or the turntable in the viewport).
//
// Side view: x forward, z up; every pivot axis runs along Y. The knuckles (turret fin, elbow,
// wrist) are thin fins on the center plane; the arms ride on one side of them, the rods on the
// other, so the two halves of each parallelogram never meet.

// ---------- layout (shared by every part, so the loops close exactly) ----------
const BASE_H = 18;
const GAP = 0.5; // under the turntable
const FIN = 4; // knuckle fins: |y| <= FIN
const LINK = [4.6, 10.6] as const; // links ride in this y band (either side)
const CAP = [11.2, 13.2] as const; // pivot caps outside the links
const PIN_R = 3.5;
const HOLE_R = 3.8; // 0.3 mm running clearance on the pins

const pt = (p: P2, d: P2): P2 => [p[0] + d[0], p[1] + d[1]];
const polar = (p: P2, len: number, deg: number): P2 => pt(p, [len * Math.cos((deg * Math.PI) / 180), len * Math.sin((deg * Math.PI) / 180)]);

/** Lower arm: 210 mm at 62° up; upper arm: 200 mm at 12° down (home pose). */
const LOWER = { length: 210, angle: 62 };
const UPPER = { length: 200, angle: -12 };

// pivots, as (x, z). Arms pivot on +y, rods on -y.
const A0: P2 = [0, 120]; // shoulder: lower arm on the turret
const B0: P2 = pt(A0, [-26, 0]); // shoulder: lower rod
const A1: P2 = polar(A0, LOWER.length, LOWER.angle); // elbow: lower arm
const B1: P2 = polar(B0, LOWER.length, LOWER.angle); // elbow: lower rod
const C0: P2 = pt(A1, [10, 34]); // elbow: upper arm
const D0: P2 = pt(C0, [0, -26]); // elbow: upper rod
const C1: P2 = polar(C0, UPPER.length, UPPER.angle); // wrist: upper arm
const D1: P2 = polar(D0, UPPER.length, UPPER.angle); // wrist: upper rod
const H: P2 = pt(C1, [40, -14]); // wrist: shade tilt
const SHADE: P2 = pt(H, [0, -46]); // shade's socket plane, on the shade axis

/** A frame on a pivot: axis along -Y, so positive angles swing counterclockwise in side view (arms up). */
const pivot = (p: P2) => ({ origin: [p[0], 0, p[1]] as [number, number, number], axis: [0, -1, 0] as [number, number, number], x: "X" as const });

// ---------- helpers ----------

/** Convex outline of `pts` grown by `r` (rounded), with `holes`, as a plate from y0 to y1. */
function plate(pts: P2[], r: number, y0: number, y1: number, holes: P2[], tag: string): Solid {
  const sk = sketch(plane.XZ.offset(-y1), { tag: `${tag}Sketch` });
  if (pts.length === 2) sk.slot(pts[0], pts[1], 2 * r, { tag: "outline" });
  else {
    const h = hull(pts);
    const n = h.length;
    const normal = (i: number): P2 => {
      const a = h[i], b = h[(i + 1) % n];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      return [(b[1] - a[1]) / l, -(b[0] - a[0]) / l]; // outward for a CCW hull
    };
    for (let i = 0; i < n; i++) {
      const a = h[i], b = h[(i + 1) % n], ni = normal(i), nj = normal((i + 1) % n);
      const s: P2 = [a[0] + r * ni[0], a[1] + r * ni[1]];
      if (i === 0) sk.moveTo(s);
      sk.lineTo([b[0] + r * ni[0], b[1] + r * ni[1]], { tag: `side${i + 1}` });
      const m = [ni[0] + nj[0], ni[1] + nj[1]];
      const ml = Math.hypot(m[0], m[1]);
      const end: P2 = [b[0] + r * nj[0], b[1] + r * nj[1]];
      sk.threePointArc([b[0] + (r * m[0]) / ml, b[1] + (r * m[1]) / ml], end, { tag: `round${i + 1}` });
    }
    sk.close();
  }
  holes.forEach((p, i) => sk.circle(p, HOLE_R, { tag: `hole${i + 1}` }));
  return sk.extrude(y1 - y0, { tag });
}

/** Counterclockwise convex hull (x, z). */
function hull(pts: P2[]): P2[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: P2[] = [], upper: P2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** A link (arm or rod) between two pivots on one side, with pin holes; its rim chamfered. */
function link(a: P2, b: P2, width: number, side: 1 | -1, tag: string): Solid {
  const [y0, y1] = side > 0 ? LINK : [-LINK[1], -LINK[0]];
  const bar = plate([a, b], width / 2, y0, y1, [a, b], tag);
  return bar.chamfer(bar.edges(`${tag}.cap & outline`), 0.8, { tag: `${tag}Edge` });
}

/** A knuckle fin through `pts` (the center plane), with a pin and cap at each pivot on its side. */
function knuckle(pts: P2[], pins: [P2, 1 | -1][], r: number, tag: string): Solid {
  let fin = plate(pts, r, -FIN, FIN, [], tag);
  fin = fin.chamfer(fin.edges(`${tag}.cap`), 1, { tag: `${tag}Edge` });
  const parts = pins.map(([p, side], i) => {
    const axis: [number, number, number] = [0, side, 0];
    const shaft = cylinder(PIN_R, CAP[0] - FIN + 1, { at: [p[0], side * (FIN - 1), p[1]], axis, tag: `${tag}Pin${i + 1}` });
    const cap = cylinder(6.5, CAP[1] - CAP[0], { at: [p[0], side * CAP[0], p[1]], axis, tag: `${tag}Cap${i + 1}` });
    const c = cap.chamfer(cap.edges("cap.end"), 0.8, { tag: `${tag}CapEdge${i + 1}` });
    return shaft.union(c, { tag: `${tag}Bolt${i + 1}` });
  });
  return fin.union(...parts, { tag: `${tag}Pinned` });
}

const ALU = { metalness: 0.85, roughness: 0.35 };

// ---------- parts ----------

export default part("Base", () => {
  const d = param("diameter", 170, { min: 140, max: 220, unit: mm });
  const disc = sketch(plane.XY).circle([0, 0], d / 2, { tag: "rim" }).extrude(BASE_H, { tag: "disc" });
  const rounded = disc.fillet(disc.edges("disc.cap.end"), 7, { tag: "topRound" });
  return rounded
    .chamfer(rounded.edges("disc.cap.start"), 1.5, { tag: "foot" })
    .color("#26282c")
    .appearance({ roughness: 0.55, metalness: 0.2 })
    .material("steel");
});

export const turret = part("Turret", () => {
  const z0 = BASE_H + GAP;
  const ring = sketch(plane.XY.offset(z0)).circle([0, 0], 42, { tag: "ring" }).extrude(10, { tag: "table" });
  const table = ring.chamfer(ring.edges("table.cap.end"), 2, { tag: "tableEdge" });
  // the tower: from the turntable up to the shoulder pivots
  const top = z0 + 10;
  const tower = sketch(plane.XZ.offset(-FIN), { tag: "towerSketch" })
    .polyline([[-40, top - 1], [16, top - 1], [9, A0[1]], [B0[0] - 9, B0[1]]], { tag: "stem" })
    .extrude(2 * FIN, { tag: "tower" });
  const shoulder = knuckle([A0, B0], [[A0, 1], [B0, -1]], 12, "shoulder");
  return table
    .union(tower, shoulder, { tag: "turret" })
    .color("#c7cbd1")
    .appearance(ALU)
    .material("aluminum")
    .connector("swivel", { origin: [0, 0, BASE_H], axis: "Z", x: "X" })
    .connector("arm", pivot(A0))
    .connector("rod", pivot(B0));
});

export const lowerArm = part("Lower arm", () =>
  link(A0, A1, 18, 1, "lowerArm").color("#d8452e").appearance({ roughness: 0.35 }).material("aluminum").connector("elbow", pivot(A1)),
);

export const lowerRod = part("Lower rod", () =>
  link(B0, B1, 11, -1, "lowerRod").color("#8b9097").appearance(ALU).material("steel").connector("elbow", pivot(B1)),
);

export const elbow = part("Elbow", () =>
  knuckle([A1, B1, C0, D0], [[A1, 1], [B1, -1], [C0, 1], [D0, -1]], 11, "elbow")
    .color("#c7cbd1")
    .appearance(ALU)
    .material("aluminum")
    .connector("arm", pivot(C0))
    .connector("rod", pivot(D0)),
);

export const upperArm = part("Upper arm", () =>
  link(C0, C1, 16, 1, "upperArm").color("#d8452e").appearance({ roughness: 0.35 }).material("aluminum").connector("wrist", pivot(C1)),
);

export const upperRod = part("Upper rod", () =>
  link(D0, D1, 10, -1, "upperRod").color("#8b9097").appearance(ALU).material("steel").connector("wrist", pivot(D1)),
);

export const wrist = part("Wrist", () =>
  knuckle([C1, D1, H], [[C1, 1], [D1, -1], [H, 1]], 10, "wrist").color("#c7cbd1").appearance(ALU).material("aluminum").connector("tilt", pivot(H)),
);

export const shade = part("Shade", () => {
  const d = param("shade", 116, { min: 96, max: 130, unit: mm, label: "shade diameter" });
  const R = d / 2;
  // a bell, 3 mm wall, on a socket; revolved about the vertical shade axis
  const bell = sketch(plane.XZ.at([SHADE[0], 0, SHADE[1]]), { tag: "bellSketch" })
    .polyline(
      [[0, 12], [17, 12], [17, -2], [30, -22], [R, -70], [R, -74], [R - 3, -74], [27, -26], [14, -6], [0, -6]],
      { tag: "profile" },
    )
    .revolve(360, { tag: "bell" });
  // the ear: rides on the wrist's tilt pin, +y side, and drops to the socket
  const ear = plate([H, pt(SHADE, [0, 8])], 8, LINK[0], LINK[1], [H], "ear");
  const earSoft = ear.chamfer(ear.edges("ear.cap & outline"), 0.8, { tag: "earEdge" });
  return bell
    .union(earSoft, { tag: "shade" })
    .color("#d8452e")
    .appearance({ roughness: 0.3 })
    .material("aluminum");
});

export const bulb = part("Bulb", () => {
  // a globe under the socket, 0.3 mm below it
  const s = sketch(plane.XZ.at([SHADE[0], 0, SHADE[1]]), { tag: "globeSketch" })
    .moveTo([0, -6.3])
    .lineTo([6, -6.3], { tag: "neckTop" })
    .lineTo([6, -15], { tag: "neck" })
    .threePointArc([15, -29], [0, -43], { tag: "glass" })
    .close();
  return s
    .revolve(360, { tag: "globe" })
    .color("#fff1c4")
    .appearance({ opacity: 0.9, roughness: 0.1 })
    .material({ name: "Glass", density: 2.5 });
});
