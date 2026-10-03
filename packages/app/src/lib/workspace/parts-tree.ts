import type { AssemblyInfo } from '@parasocial/runtime/protocol';
import { findAssemblyScope } from '@parasocial/runtime/assembly-scope';

export type PartNode = { kind: 'part'; id: string };
export type AssemblyNode = { kind: 'assembly' | 'subassembly'; id: string; name: string; description?: string; definition: string; ids: string[]; children: PartsNode[] };
export type PartsNode = PartNode | AssemblyNode;

/** Preserve inserted scopes in the Parts tree while keeping the engine's body order. */
export function assemblyTree(info: AssemblyInfo, assemblies: AssemblyInfo[]): AssemblyNode {
	const positions = new Map(info.instances.map((i, n) => [i.id, n]));
	const build = (id: string, kind: AssemblyNode['kind']): AssemblyNode => {
		const scope = findAssemblyScope(assemblies, id)!;
		const children: PartsNode[] = [
			...info.instances.filter((i) => i.scope === id).map((i): PartNode => ({ kind: 'part', id: i.id })),
			...info.subs.filter((s) => s.parent === id).map((s) => build(s.id, 'subassembly'))
		];
		const order = (node: PartsNode) => positions.get(node.kind === 'part' ? node.id : node.ids[0]) ?? Infinity;
		children.sort((a, b) => order(a) - order(b));
		const description = assemblies.find((a) => a.id === scope.definition)?.description;
		return { kind, id, name: scope.name, ...(description && { description }), definition: scope.definition, ids: scope.instances.map((i) => i.id), children };
	};
	return build(info.id, 'assembly');
}
