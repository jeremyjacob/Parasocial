// An assembly as the solver sees it: connector frames looked up in the parts' regenerations, every
// copy laid out at home (placed, or put against another by connector-to-connector joints), and
// each joint's frame on each body. Shared by the app and tests so they build the same solver.
import { layout, flipFrame, type Mechanism, type Frame, type CouplingSpec, type JointSpec, type LayoutJoint, type MechanismSpec, type Pose } from "@parasocial/assembly";
import { sourcePart, type AssemblyInfo, type AssemblyJoint, type ConnectorAt } from "./protocol";

type ConnectorFrame = Frame;
type SourceRef = NonNullable<AssemblyJoint["source"]>;

export type AssemblyIssue = { message: string; source?: SourceRef };

export type ResolvedAssembly = {
  /** Joints, home transforms and fixed bodies, ready for `new Mechanism` (add a `scale`). */
  spec: Omit<MechanismSpec, "scale">;
  /** Joints that couldn't be set up (a missing connector or frame index). */
  problems: AssemblyIssue[];
  /** Some part hasn't regenerated yet: build once it has. */
  pending: boolean;
};

/**
 * `connectors(part)` is a source part's connectors from its last regeneration, or null when it
 * hasn't regenerated yet. `nameOf` names a part in messages.
 */
export function resolveAssembly(info: AssemblyInfo, connectors: (part: string) => Record<string, ConnectorFrame[]> | null | undefined, nameOf: (part: string) => string = (p) => p): ResolvedAssembly {
  const problems: AssemblyIssue[] = [];
  let pending = false;
  const pick = (part: string, at: ConnectorAt, source?: SourceRef): ConnectorFrame | undefined => {
    const all = connectors(part);
    if (all === null || all === undefined) return void (pending = true);
    const fs = all[at.connector];
    const n = fs?.length ?? 0;
    const name = nameOf(part);
    if (!n) return void problems.push({ message: `${name} has no connector "${at.connector}": add .connector("${at.connector}", ...) to its body`, source });
    if (at.index === undefined) {
      if (n > 1) return void problems.push({ message: `${name} has ${n} "${at.connector}" frames: pick one, .at("${at.connector}", 0) to .at("${at.connector}", ${n - 1})`, source });
      return fs[0];
    }
    if (at.index >= n) return void problems.push({ message: `${name} has ${n} "${at.connector}" frame${n > 1 ? "s" : ""} (${n > 1 ? `0 to ${n - 1}` : "0"}), so there's no .at("${at.connector}", ${at.index})`, source });
    return fs[at.index];
  };

  const joints: { j: AssemblyInfo["joints"][number]; lj: LayoutJoint }[] = [];
  for (const j of info.joints) {
    const base = { a: j.a, b: j.b, scope: j.scope };
    if ("frame" in j.at) joints.push({ j, lj: { ...base, frame: j.at.frame } });
    else if ("mate" in j.at) {
      const fa = pick(sourcePart(j.a), j.at.mate.a, j.source),
        fb = pick(sourcePart(j.b), j.at.mate.b, j.source);
      if (fa && fb) joints.push({ j, lj: { ...base, mate: { a: fa, b: j.at.flip ? flipFrame(fb) : fb } } });
    } else {
      const f = pick(j.at.part, j.at, j.source);
      if (f) joints.push({ j, lj: { ...base, frame: f, owner: j.at.owner } });
    }
  }
  const { home, frames, conflicts } = layout({
    root: info.id,
    bodies: info.instances.map((i) => ({ id: i.id, scope: i.scope, place: i.place })),
    scopes: info.subs.map((s) => ({ id: s.id, parent: s.parent, place: s.place })),
    joints: joints.map((x) => x.lj),
    fixed: info.fixed,
  });
  // placed apart and joined: world positions win (each placement says where), so say so
  const label = instanceLabel(nameOf);
  for (const i of conflicts) {
    const { j } = joints[i];
    problems.push({ message: `${label(j.a)} and ${label(j.b)} are placed separately, so their ${j.type} joint "${j.name}" holds them where placed, not as modeled relative to each other: place only one of them (what's joined to it follows)`, source: j.source });
  }
  const specs: JointSpec[] = [];
  joints.forEach(({ j }, i) => {
    const f = frames[i];
    if (f) specs.push({ name: j.name, type: j.type, a: j.a, b: j.b, frames: f, limits: j.limits, value: j.value });
  });
  const homes: Record<string, Pose> = {};
  for (const [id, p] of home) homes[id] = p;
  // relations between joints that were set up (one with a missing connector is reported above)
  const set = new Set(specs.map((j) => j.name));
  const couplings: CouplingSpec[] = (info.relations ?? []).filter((r) => set.has(r.a) && set.has(r.b)).map((r) => ({ a: r.a, ia: r.ia, b: r.b, ib: r.ib, ratio: r.ratio, offset: r.offset }));
  return { spec: { joints: specs, couplings, fixed: info.fixed, home: homes }, problems, pending };
}

/** An instance in messages: its part's name, and its copy name. */
const instanceLabel = (nameOf: (part: string) => string) => (id: string) => {
  const at = id.lastIndexOf("@");
  return `${nameOf(sourcePart(id))}${at > id.lastIndexOf("/") ? ` "${id.slice(at + 1)}"` : ""}`;
};

/**
 * Why a solved mechanism is still `err` off: the joint furthest from closing, and whether fixed
 * parts hold it open (each side hangs from a different one).
 */
export function unsatisfied(mech: Mechanism, err: number, nameOf: (part: string) => string = (p) => p): string {
  const w = mech.worst();
  const off = `off by ${err.toFixed(2)}`;
  if (!w) return `the joints can't all be satisfied (${off}): check that connectors line up where the parts are modeled or placed`;
  if (!w.fixed) return `joint "${w.joint}" can't close (${off}): check that connectors line up where the parts are modeled or placed`;
  const [a, b] = w.fixed.map(instanceLabel(nameOf));
  return `joint "${w.joint}" can't close (${off}): it's held between two fixed parts, ${a} and ${b} (${w.fixed.join(", ")}), and nothing between them can move enough; fix only one (fix(sub) holds a subassembly by its root part)`;
}
