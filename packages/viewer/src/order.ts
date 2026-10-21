// A sensible order to put an assembly together in, from its parts' bounds alone: what a new build
// script's steps start from (the steps themselves are the script's to say).
import * as THREE from "three";

/** A level of the assembly hierarchy: its own pieces and its sub-assemblies. */
export type OrderNode<T> = { pieces: { item: T; box: THREE.Box3; vol: number }[]; kids: OrderNode<T>[] };

const boxVol = (b: THREE.Box3, pad: number) => (b.max.x - b.min.x + 2 * pad) * (b.max.y - b.min.y + 2 * pad) * (b.max.z - b.min.z + 2 * pad);

/**
 * Build order, inside-out through the hierarchy: a sub-assembly builds in one go. Within a level,
 * when most of an item's pieces lie inside a much bigger item's bounds: a hollow one (a housing, a
 * cup) waits for what it holds, except small things reaching its walls (screws, inserts, a button
 * poking through) that are fastened on after; a solid one goes first and what's in it after. Of what's free to go, ordinary pieces before covers
 * (hollow ones enclosing something, or big hollow shells), then those reaching least far from the
 * level's centre, then bottom-up.
 */
export function buildOrder<T>(root: OrderNode<T>): T[] {
  type Bounds = { box: THREE.Box3; vol: number; boxes: THREE.Box3[] };
  type Item = Bounds & { piece?: T; kid?: OrderNode<T> };
  const out: T[] = [];
  const bounds = new Map<OrderNode<T>, Bounds>();
  const measure = (nd: OrderNode<T>) => {
    const m: Bounds = { box: new THREE.Box3(), vol: 0, boxes: [] };
    for (const q of nd.pieces) m.box.union(q.box), (m.vol += q.vol), m.boxes.push(q.box);
    for (const k of nd.kids) {
      const km = measure(k);
      m.box.union(km.box), (m.vol += km.vol), m.boxes.push(...km.boxes);
    }
    bounds.set(nd, m);
    return m;
  };
  measure(root);
  const level = (nd: OrderNode<T>) => {
    const { box } = bounds.get(nd)!;
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1e-9);
    const pad = r * 0.01;
    const items: Item[] = [
      ...nd.pieces.map((q) => ({ box: q.box, vol: q.vol, boxes: [q.box], piece: q.item })),
      ...nd.kids.filter((k) => !bounds.get(k)!.box.isEmpty()).map((k) => ({ ...bounds.get(k)!, kid: k })),
    ];
    const bv = items.map((it) => boxVol(it.box, pad));
    const padded = items.map((it) => it.box.clone().expandByScalar(pad));
    const levelVol = boxVol(box, pad);
    const hollow = items.map((it, a) => it.vol < 0.4 * bv[a]);
    // an item's biggest piece, and how much of its pieces' bounds lie inside each other item's
    const biggest = items.map((it) => Math.max(...it.boxes.map((b) => boxVol(b, pad))));
    const x = new THREE.Box3();
    const share = (a: number, b: number) => {
      let inside = 0,
        all = 0;
      for (const q of items[b].boxes) {
        all += boxVol(q, pad);
        x.copy(q).expandByScalar(pad).intersect(padded[a]);
        if (!x.isEmpty()) inside += boxVol(x, 0);
      }
      return inside / Math.max(all, 1e-30);
    };
    // a small part reaching a's walls: a fastener (or a set of them), not something a holds; a
    // sub-assembly never is
    const fastener = (a: number, b: number) => {
      if (items[b].kid?.kids.length || biggest[b] >= 0.03 * bv[a]) return false;
      const A = items[a].box;
      return items[b].boxes.some((q) =>
        (["x", "y", "z"] as const).some((k) => {
          const m = 0.08 * (A.max[k] - A.min[k]) + pad;
          return q.min[k] <= A.min[k] + m || q.max[k] >= A.max[k] - m;
        }),
      );
    };
    // before[a]: the items that land before a
    const before = items.map((): number[] => []);
    const encloses = items.map(() => false);
    items.forEach((_, a) =>
      items.forEach((_, b) => {
        if (a === b || bv[a] < 1.5 * biggest[b] || share(a, b) < 0.6) return;
        if (hollow[a] && !fastener(a, b)) before[a].push(b), (encloses[a] = true);
        else before[b].push(a);
      }),
    );
    const cover = items.map((_, a) => encloses[a] || (hollow[a] && bv[a] >= 0.2 * levelVol));
    const corner = new THREE.Vector3();
    const reach = items.map(({ box: b }) => {
      let m = 0;
      for (let i = 0; i < 8; i++) m = Math.max(m, corner.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).distanceTo(c));
      return Math.round((m / r) * 10);
    });
    const done = new Set<number>();
    while (done.size < items.length) {
      let best = -1;
      for (let a = 0; a < items.length; a++) {
        if (done.has(a) || before[a].some((b) => !done.has(b))) continue;
        if (best < 0) best = a;
        else {
          const A = items[a].box,
            B = items[best].box;
          const d = +cover[a] - +cover[best] || reach[a] - reach[best] || A.min.z - B.min.z || A.min.x - B.min.x || A.min.y - B.min.y;
          if (d < 0) best = a;
        }
      }
      // mixed hollow and solid nesting can tie a knot: then take the next one regardless
      if (best < 0) best = items.findIndex((_, a) => !done.has(a));
      done.add(best);
      const it = items[best];
      if (it.kid) level(it.kid);
      else out.push(it.piece!);
    }
  };
  level(root);
  return out;
}
