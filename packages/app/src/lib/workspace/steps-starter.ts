// A first build script for an assembly that has none: one step per part (its copies together) and
// per subassembly, outward from the fixed part along the joints; parts as many joints away go in the
// order their bounds suggest (inside-out: what a housing holds before the housing, screws after what
// they fasten). Every step comes in from above; the script is the person's
// (or the agent's) to refine.
import * as THREE from 'three';
import { buildOrder, type OrderNode } from '@parasocial/viewer';
import type { AssemblyInfo, PartInfo } from '@parasocial/runtime/protocol';

export type StarterScene = {
	/** World bounds and volume of a copy (null: not regenerated yet). */
	bounds(id: string): { box: THREE.Box3; vol: number } | null;
};

type Unit = { key: string; kind: 'part' | 'sub'; ids: string[]; name: string; ref: { file: string; export: string }; subName?: string };

const ident = (s: string) => {
	const words = s.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
	const id = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w[0].toLowerCase() + w.slice(1))).join('') || 'part';
	return /^[0-9]/.test(id) ? `_${id}` : id;
};
const RESERVED = new Set(['buildSteps', 'step', 'sub', 'copy', 'default', 'new', 'class', 'function', 'import', 'export', 'const', 'let', 'var', 'return', 'for', 'if', 'else', 'switch', 'case', 'delete', 'in', 'of', 'do', 'while', 'with', 'this', 'true', 'false', 'null', 'void', 'typeof', 'yield', 'await', 'try', 'catch', 'finally', 'throw', 'super', 'extends', 'enum', 'debugger', 'continue', 'break']);
/** "Lid" → "lid", keeping acronyms ("PCB"). */
const lower = (n: string) => (/^[A-Z][a-z]/.test(n) ? n[0].toLowerCase() + n.slice(1) : n);

/** The path of a build script for `assembly` that isn't taken yet. */
export function starterPath(assembly: AssemblyInfo, taken: Set<string>) {
	const stem = assembly.id.replace(/:/g, '-');
	let path = `builds/${stem}.ts`;
	for (let n = 2; taken.has(path); n++) path = `builds/${stem}-${n}.ts`;
	return path;
}

export function starterScript(a: AssemblyInfo, ctx: { parts: PartInfo[]; assemblies: AssemblyInfo[]; scene: StarterScene; partName: (id: string) => string }): string {
	const units: Unit[] = [];
	for (const s of a.subs.filter((s) => s.parent === a.id)) {
		const def = ctx.assemblies.find((x) => x.id === s.assembly);
		if (!def) continue;
		const ids = a.instances.filter((i) => i.id.startsWith(`${s.id}/`)).map((i) => i.id);
		if (ids.length) units.push({ key: s.id, kind: 'sub', ids, name: s.name ? `${def.name} ${s.name}` : def.name, ref: { file: def.file, export: def.export }, subName: s.name });
	}
	const byPart = new Map<string, string[]>();
	for (const i of a.instances.filter((i) => i.scope === a.id)) byPart.set(i.part, [...(byPart.get(i.part) ?? []), i.id]);
	for (const [part, ids] of byPart) {
		const info = ctx.parts.find((p) => p.id === part);
		if (info) units.push({ key: part, kind: 'part', ids, name: ctx.partName(part), ref: { file: info.file, export: info.export } });
	}

	// order: each unit's copies as one level of the hierarchy
	const root: OrderNode<string> = { pieces: [], kids: [] };
	for (const u of units) {
		const pieces = u.ids.flatMap((id) => {
			const b = ctx.scene.bounds(id);
			return b && !b.box.isEmpty() ? [{ item: u.key, box: b.box, vol: b.vol }] : [];
		});
		if (pieces.length === 1) root.pieces.push(pieces[0]);
		else if (pieces.length) root.kids.push({ pieces, kids: [] });
	}
	const rank = [...new Set(buildOrder(root))];
	// outward from what's fixed along the joints (a part goes in once what it's joined to is there);
	// the bounds decide between parts the same number of joints away
	const depth = new Map<string, number>();
	const roots = a.fixed.length ? a.fixed : a.instances.slice(0, 1).map((i) => i.id);
	let ring = roots.filter((id) => !depth.has(id) && depth.set(id, 0));
	for (let d = 1; ring.length; d++) {
		const next: string[] = [];
		for (const j of a.joints)
			for (const [x, y] of [[j.a, j.b], [j.b, j.a]]) if (ring.includes(x) && !depth.has(y)) depth.set(y, d), next.push(y);
		ring = next;
	}
	const at = (u: Unit) => Math.min(...u.ids.map((id) => depth.get(id) ?? Infinity));
	const idx = (u: Unit) => (rank.indexOf(u.key) + 1 || Infinity);
	const ordered = [...units].sort((x, y) => at(x) - at(y) || idx(x) - idx(y));

	// imports, one name per export
	const used = new Set<string>(RESERVED);
	const names = new Map<string, string>();
	const nameFor = (ref: Unit['ref'], fallback: string) => {
		const key = `${ref.file}#${ref.export}`;
		let n = names.get(key);
		if (n) return n;
		const base = ref.export === 'default' ? ident(fallback) : ref.export;
		n = base;
		for (let i = 2; used.has(n); i++) n = `${base}${i}`;
		used.add(n);
		names.set(key, n);
		return n;
	};
	const asmName = nameFor({ file: a.file, export: a.export }, a.name);
	for (const u of ordered) nameFor(u.ref, u.kind === 'sub' ? ctx.assemblies.find((x) => x.file === u.ref.file && x.export === u.ref.export)?.name ?? u.name : u.name);
	const byFile = new Map<string, { def?: string; named: string[] }>();
	for (const [key, n] of names) {
		const [file, exp] = key.split('#');
		const e = byFile.get(file) ?? { named: [] };
		if (exp === 'default') e.def = n;
		else e.named.push(exp === n ? n : `${exp} as ${n}`);
		byFile.set(file, e);
	}
	const imports = [...byFile]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([file, e]) => {
			const what = [e.def, e.named.length ? `{ ${e.named.join(', ')} }` : ''].filter(Boolean).join(', ');
			return `import ${what} from "../${file.slice(0, -'.ts'.length)}";`;
		});

	const q = (s: string) => JSON.stringify(s);
	const hasSub = ordered.some((u) => u.kind === 'sub');
	const lines = ordered.map((u, i) => {
		const ref = names.get(`${u.ref.file}#${u.ref.export}`)!;
		const target = u.kind === 'sub' ? `sub(${ref}${u.subName === undefined ? '' : `, ${q(u.subName)}`})` : ref;
		const title = u.kind === 'sub' ? `Fit the ${lower(u.name)}` : i === 0 ? `Set down the ${lower(u.name)}` : `Add the ${lower(u.name)}${u.ids.length > 1 ? ` (${u.ids.length})` : ''}`;
		const opts = u.ids.length > 1 && u.kind === 'part' ? ', { stagger: 0.15 }' : '';
		return `  step(${q(title)}, ${target}${opts});`;
	});
	return [
		'import { buildSteps } from "parasocial";',
		...imports,
		'',
		`// How ${a.name} goes together, one step at a time. Each step brings in parts and says how they go`,
		'// in: from: [x, y, z] (where it starts, mm from its place), along: "Z" | part.at("connector") with',
		'// distance (slides in along an axis), turn: degrees (screws). Play it with the build button (A).',
		`export default buildSteps(${asmName}, ({ step${hasSub ? ', sub' : ''} }) => {`,
		...lines,
		'});',
		''
	].join('\n');
}
