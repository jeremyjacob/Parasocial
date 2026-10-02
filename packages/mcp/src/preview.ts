// Session-local previews for MCP agents: param overrides and assembly joint values that only this
// MCP session sees. They're applied to the session's own engine jobs (render, measure, check,
// describe…) and never written anywhere: no version, no configuration change, nothing another
// agent or a person sees. Committing to the shared document is a separate, explicit step
// (set_param / set_pose with scope "shared").
//
// Also: assembly poses for MCP, solved the way the app solves them (resolveAssembly + Mechanism,
// starting from the document's saved joint values), and expanding assembly ids to their instances.
import { Mechanism, JOINT_VARS, applyPoint, applyDir, isIdentity, type Pose, type Vec3 } from "@parasocial/assembly";
import { resolveAssembly, unsatisfied } from "@parasocial/runtime/mechanism";
import { sourcePart, type AssemblyInfo, type PartPose } from "@parasocial/runtime/protocol";

export type Preview = {
  /** part -> param -> expression */
  params: Record<string, Record<string, string | number>>;
  /** assembly id -> joint name -> values (deg / mm) */
  poses: Record<string, Record<string, number[]>>;
};

export const emptyPreview = (): Preview => ({ params: {}, poses: {} });

export const hasPreview = (p: Preview | undefined) => !!p && (Object.keys(p.params).length > 0 || Object.keys(p.poses).length > 0);

/** A configuration's overrides with this session's preview overrides on top. */
export function mergeOverrides(base: Record<string, Record<string, string | number>>, preview?: Preview) {
  if (!preview || !Object.keys(preview.params).length) return base;
  const out: Record<string, Record<string, string | number>> = {};
  for (const part of new Set([...Object.keys(base), ...Object.keys(preview.params)])) out[part] = { ...base[part], ...preview.params[part] };
  return out;
}

/** What a part's regeneration says, as far as poses need it. */
export type PartMeta = { name?: string; empty?: boolean; connectors?: Record<string, any[]>; bbox?: { min: number[]; max: number[] } };

export type JointState = { name: string; type: string; a: string; b: string; value: number[]; units: ("deg" | "mm")[]; limits: ({ min?: number; max?: number } | null)[]; from: "session" | "shared" | "home" };
export type AssemblyState = {
  id: string;
  name: string;
  studio: string;
  instances: string[];
  joints: JointState[];
  problems: string[];
  /** Instance id -> transform from where its part is modeled (identity ones left out). */
  poses: Record<string, PartPose>;
};

/**
 * Solve every assembly: the shared saved values (documents.settings.poses) first, then this
 * session's values on top (the rest settle around them), as the app does after a drag.
 */
export function solveAssemblies(infos: AssemblyInfo[], parts: (part: string) => PartMeta | undefined, shared: Record<string, Record<string, number[]>> = {}, session: Record<string, Record<string, number[]>> = {}): { poses: Record<string, PartPose>; assemblies: AssemblyState[] } {
  const poses: Record<string, PartPose> = {};
  const assemblies: AssemblyState[] = [];
  for (const info of infos) {
    const problems = info.problems.map((p) => p.message);
    const nameOf = (p: string) => parts(p)?.name ?? p;
    const resolved = resolveAssembly(
      info,
      (p) => {
        const r = parts(p);
        return !r || r.empty ? null : (r.connectors ?? {});
      },
      nameOf,
    );
    problems.push(...resolved.problems.map((p) => p.message));
    const state: AssemblyState = { id: info.id, name: info.name, studio: info.studio, instances: info.instances.map((i) => i.id), joints: [], problems, poses: {} };
    assemblies.push(state);
    const { joints, home } = resolved.spec;
    if (resolved.pending) problems.push("some of its parts failed to regenerate, so it shows unposed");
    if (resolved.pending || (!joints.length && Object.values(home ?? {}).every((p) => isIdentity(p as Pose)))) {
      state.joints = info.joints.filter((j) => JOINT_VARS[j.type].length).map((j) => jointState(j, j.value, "home"));
      continue;
    }
    let scale = 0;
    for (const j of joints)
      for (const p of [j.a, j.b]) {
        const bb = parts(sourcePart(p))?.bbox;
        if (bb) scale = Math.max(scale, Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) / 2);
      }
    const mech = new Mechanism({ ...resolved.spec, scale: scale || 50 });
    const saved = shared[info.id];
    let err = saved ? mech.setValues(saved) : mech.settle();
    const mine = session[info.id];
    if (mine && Object.keys(mine).length) err = mech.setValues(mine);
    if (err > 1e-3) problems.push(unsatisfied(mech, err, nameOf));
    const values = mech.values();
    state.joints = info.joints.filter((j) => JOINT_VARS[j.type].length).map((j) => jointState(j, values[j.name] ?? j.value, mine?.[j.name] ? "session" : saved?.[j.name] ? "shared" : "home"));
    for (const [p, pose] of mech.poses()) if (!isIdentity(pose)) state.poses[p] = poses[p] = { r: [...pose.r], t: [pose.t[0], pose.t[1], pose.t[2]] };
  }
  return { poses, assemblies };
}

function jointState(j: AssemblyInfo["joints"][number], value: number[], from: JointState["from"]): JointState {
  const kinds = JOINT_VARS[j.type];
  return { name: j.name, type: j.type, a: j.a, b: j.b, value: value.map((v) => +v.toFixed(4)), units: kinds.map((k) => (k === "angle" ? "deg" : "mm")), limits: j.limits.slice(0, kinds.length), from };
}

/** Find an assembly by id or display name. */
export function findAssembly(infos: AssemblyInfo[], key: string): AssemblyInfo | undefined {
  return infos.find((a) => a.id === key) ?? infos.find((a) => a.name.toLowerCase() === key.toLowerCase());
}

/**
 * Check and normalize joint values for an assembly: names must exist, a number stands for a
 * one-variable joint, arrays need the joint's arity.
 */
export function jointValues(info: AssemblyInfo, joints: Record<string, number | number[]>): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  const movable = info.joints.filter((j) => JOINT_VARS[j.type].length);
  const list = () => movable.map((j) => `${j.name} (${j.type}: ${JOINT_VARS[j.type].map((k) => (k === "angle" ? "deg" : "mm")).join(", ")})`).join("; ") || "none";
  for (const [name, v] of Object.entries(joints)) {
    const j = movable.find((x) => x.name === name);
    if (!j) {
      // a subassembly's joints are named under where it's inserted: "<assembly id>@<insert name>/<joint>"
      const scoped = movable.filter((x) => x.name.endsWith(`/${name}`) || x.name.split("/").pop() === name.split("/").pop());
      const hint = scoped.length ? ` Did you mean ${scoped.map((x) => `"${x.name}"`).join(" or ")}? Joints in an inserted assembly are named "<its assembly id>@<insert name>/<joint>".` : "";
      throw new Error(`No movable joint "${name}" in assembly ${info.id}.${hint} Joints: ${list()}`);
    }
    const q = Array.isArray(v) ? v : [v];
    const n = JOINT_VARS[j.type].length;
    if (q.length !== n || !q.every(Number.isFinite)) throw new Error(`Joint "${name}" is ${j.type}: give ${n} number${n > 1 ? "s" : ""} (${JOINT_VARS[j.type].map((k) => (k === "angle" ? "deg" : "mm")).join(", ")}).`);
    out[name] = q;
  }
  return out;
}

/**
 * Render/measure targets: part ids stay, instance ids (`<assembly>/<part>`) stay, and an
 * assembly id stands for all its instances. Unknown ids are reported.
 */
export function expandTargets(ids: string[], parts: string[], infos: AssemblyInfo[]): { ids: string[]; unknown: string[] } {
  const out: string[] = [];
  const unknown: string[] = [];
  const instances = new Set(infos.flatMap((a) => a.instances.map((i) => i.id)));
  for (const id of ids) {
    const asm = findAssembly(infos, id);
    if (parts.includes(id) || instances.has(id)) out.push(id);
    else if (asm) out.push(...asm.instances.map((i) => i.id));
    else unknown.push(id);
  }
  return { ids: [...new Set(out)], unknown };
}

/** Where a part-space bounding box ends up under a pose (the box around its eight corners). */
export function posedBox(bb: { min: number[]; max: number[] }, pose: PartPose) {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const c: Vec3 = [i & 1 ? bb.max[0] : bb.min[0], i & 2 ? bb.max[1] : bb.min[1], i & 4 ? bb.max[2] : bb.min[2]];
    const w = applyPoint(pose as Pose, c);
    for (let k = 0; k < 3; k++) (min[k] = Math.min(min[k], w[k])), (max[k] = Math.max(max[k], w[k]));
  }
  return { min, max };
}

export const posedPoint = (p: number[] | undefined, pose?: PartPose) => (p && pose ? applyPoint(pose as Pose, p as Vec3) : p);
export const posedDir = (d: number[] | undefined, pose?: PartPose) => (d && pose ? applyDir(pose as Pose, d as Vec3) : d);
