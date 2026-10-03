// Assembly scopes retain their identity even though the solver works on flattened bodies.
import type { AssemblyInfo } from "./engine";

/** Scope ids use path segments; similarly named copies (left and left2) are independent. */
export const withinScope = (scope: string, parent: string) => scope === parent || scope.startsWith(`${parent}/`);

export type AssemblyScope = {
  /** The exported assembly that owns this copy and its saved joint values. */
  assembly: AssemblyInfo;
  id: string;
  name: string;
  definition: string;
  partNumber?: string;
  description?: string;
  instances: AssemblyInfo["instances"];
  subs: AssemblyInfo["subs"];
  joints: AssemblyInfo["joints"];
  relations: AssemblyInfo["relations"];
};

/** An exported assembly or an inserted copy, including its nested copies. Unknown ids stay unknown. */
export function findAssemblyScope(assemblies: AssemblyInfo[], id: string): AssemblyScope | undefined {
  const assembly = assemblies.find((a) => a.id === id || a.subs.some((s) => s.id === id));
  if (!assembly) return;
  const sub = assembly.subs.find((s) => s.id === id);
  const definition = sub?.assembly ?? assembly.id;
  const source = assemblies.find((a) => a.id === definition);
  const label = source?.name ?? definition;
  return {
    assembly, id, definition,
    name: sub?.name === undefined ? label : `${label} ${sub.name}`,
    ...(source?.partNumber !== undefined && { partNumber: source.partNumber }),
    ...(source?.description !== undefined && { description: source.description }),
    instances: assembly.instances.filter((i) => withinScope(i.scope, id)),
    subs: assembly.subs.filter((s) => s.id !== id && withinScope(s.parent, id)),
    joints: assembly.joints.filter((j) => withinScope(j.scope, id)),
    relations: assembly.relations.filter((r) => withinScope(r.scope, id)),
  };
}
