// Where an assembly's bodies sit at home (every joint at 0), and each joint's frame on each body.
//
// A body is a copy of a part. It sits where its script placed it, else where a connector-to-connector
// joint (a mate) puts it against a body already laid out, else where the part is modeled. An
// inserted subassembly is a scope: its bodies are laid out in its own coordinates first, then the
// whole scope is placed the same way (by its placement, or by a mate onto one of its bodies), so
// its bodies keep their places relative to each other. Frames given in a scope's coordinates (a
// joint `at` a point, or at a connector of a third part) become a frame on each body.
import { compose, framePose, identity, inverse, type Frame, type Pose } from "./pose";

export type LayoutBody = {
  id: string;
  /** The scope it's in: the root, or an inserted subassembly. */
  scope: string;
  /** Where the script placed it, in its scope's coordinates. */
  place?: Pose;
};

/** An inserted subassembly, placed in its parent scope. */
export type LayoutScope = { id: string; parent: string; place?: Pose };

export type LayoutJoint = {
  a: string;
  b: string;
  /** The scope that declared the joint: its bodies are in it (or in scopes inside it). */
  scope: string;
} & (
  | /** A frame in the scope's coordinates, or on `owner` (a body, in its part's coordinates). */ { frame: Frame; owner?: string }
  | /** Connector to connector: a frame on each body (they coincide at home). */ { mate: { a: Frame; b: Frame } }
);

export type LayoutSpec = {
  root: string;
  /** In order of preference for staying where modeled: the first body of each connected group stays put unless something places it. */
  bodies: LayoutBody[];
  scopes?: LayoutScope[];
  joints: LayoutJoint[];
  /** Bodies that never move: they anchor their group. */
  fixed?: string[];
};

export type Layout = {
  /** Every body's home transform (its part's coordinates to the world). */
  home: Map<string, Pose>;
  /** Per joint (same order), the frame on each body; missing when a body isn't in the joint's scope. */
  frames: ({ a: Frame; b: Frame } | undefined)[];
};

type Item = { place?: Pose; members: Map<string, Pose> };

export function layout(spec: LayoutSpec): Layout {
  const scopes = spec.scopes ?? [];
  const fixed = new Set(spec.fixed ?? []);
  const frames: Layout["frames"] = spec.joints.map(() => undefined);

  /** Homes of every body under `scope`, in its coordinates. */
  const solve = (scope: string): Map<string, Pose> => {
    const items: Item[] = [];
    const itemOf = new Map<string, Item>();
    for (const b of spec.bodies)
      if (b.scope === scope) {
        const it: Item = { place: b.place, members: new Map([[b.id, identity()]]) };
        items.push(it);
        itemOf.set(b.id, it);
      }
    for (const c of scopes)
      if (c.parent === scope) {
        const it: Item = { place: c.place, members: solve(c.id) };
        items.push(it);
        for (const id of it.members.keys()) itemOf.set(id, it);
      }
    const joints = spec.joints.map((j, i) => [j, i] as const).filter(([j]) => j.scope === scope);
    const X = new Map<Item, Pose>();
    const home = (id: string) => {
      const it = itemOf.get(id);
      const x = it && X.get(it);
      return x && compose(x, it.members.get(id)!);
    };
    // mates carry placement outward from what's already laid out
    const spread = (start: Item) => {
      const queue = [start];
      while (queue.length) {
        const it = queue.shift()!;
        for (const [j] of joints) {
          if (!("mate" in j)) continue;
          const ia = itemOf.get(j.a),
            ib = itemOf.get(j.b);
          if (!ia || !ib || ia === ib) continue;
          const Fa = framePose(j.mate.a),
            Fb = framePose(j.mate.b);
          if (ia === it && !X.has(ib) && !ib.place) {
            const Tb = compose(home(j.a)!, compose(Fa, inverse(Fb)));
            X.set(ib, compose(Tb, inverse(ib.members.get(j.b)!)));
            queue.push(ib);
          } else if (ib === it && !X.has(ia) && !ia.place) {
            const Ta = compose(home(j.b)!, compose(Fb, inverse(Fa)));
            X.set(ia, compose(Ta, inverse(ia.members.get(j.a)!)));
            queue.push(ia);
          }
        }
      }
    };
    const seeds = [...items.filter((i) => i.place), ...items.filter((i) => [...i.members.keys()].some((id) => fixed.has(id))), ...items];
    for (const s of seeds)
      if (!X.has(s)) {
        X.set(s, s.place ?? identity());
        spread(s);
      }
    for (const [j, i] of joints) {
      const Ha = home(j.a),
        Hb = home(j.b);
      if (!Ha || !Hb) continue;
      if ("mate" in j) {
        frames[i] = { a: j.mate.a, b: j.mate.b };
        continue;
      }
      const at = framePose(j.frame);
      const owner = j.owner !== undefined ? home(j.owner) : undefined;
      const F = owner ? compose(owner, at) : at;
      frames[i] = { a: poseFrame(compose(inverse(Ha), F)), b: poseFrame(compose(inverse(Hb), F)) };
    }
    const out = new Map<string, Pose>();
    for (const it of items) for (const [id, h] of it.members) out.set(id, compose(X.get(it)!, h));
    return out;
  };

  return { home: solve(spec.root), frames };
}

/** A pose as a frame: its origin and x, z axes. */
export function poseFrame(p: Pose): Frame {
  const r = p.r;
  return { origin: [...p.t], x: [r[0], r[3], r[6]], z: [r[2], r[5], r[8]] };
}

/** The same frame turned half a turn about its x axis (z reversed): a mate that faces the other way. */
export function flipFrame(f: Frame): Frame {
  return { origin: f.origin, x: f.x, z: [-f.z[0], -f.z[1], -f.z[2]] };
}
