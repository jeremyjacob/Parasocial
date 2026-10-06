// Workspace state (§8): the synced document (Zero), the engine (regeneration), the viewer
// (geometry), selection, tools and undo. Geometry never enters Svelte state (§9): meshes go
// straight from the engine to the viewer; Svelte only sees lightweight metadata.
import { untrack } from 'svelte';
import type { Viewer, EntityRef } from '@parasocial/viewer';
import { mutators, captureInverse, captureInverseAll, type AnyMR, type ParasocialZero, type Script, type Configuration, type ParamOverride, type Version, type Note, type AgentSession, type Document as DocRow } from '@parasocial/sync';
import { sourcePart, type PartResult, type PartInfo, type EngineInfo, type AssemblyInfo, type AssemblyInstance } from '@parasocial/runtime/protocol';
import { findAssemblyScope } from '@parasocial/runtime/assembly-scope';
import { packResult, unpackResult, derivedKey, type CachedPart } from '@parasocial/runtime/pack';
import type { EngineClient } from '@parasocial/runtime/browser/client';
import { partColorAt } from '$lib/styles/tokens';
import { newID } from '$lib/zero';
import { AssemblyController } from './assembly.svelte';

type Mesh = NonNullable<ReturnType<Viewer['meshOf']>>;

export type Tool = 'select' | 'note' | 'pencil' | 'measure';
export type PartMeta = Omit<PartResult, 'mesh'> & { names?: { face: string[]; edge: string[] }; fromCache?: boolean };
export type RegenState = 'idle' | 'running' | 'queued';
type Visibility = { part: string; hidden: boolean };
type Undo = { label: string } & (
	| { kind: 'mutation'; undo: AnyMR[]; redo: AnyMR[] }
	| { kind: 'visibility'; undo: Visibility[]; redo: Visibility[] }
);

const DERIVED_CACHE = 'parasocial-derived-v1';
/** Part id that shared params' overrides live under (`param(..., { shared: true })`). */
export const SHARED = '*';
const BUILD_KEY = 'parasocial:engineBuild';

export class WorkspaceState {
	readonly documentID: string;
	readonly zero: ParasocialZero;
	readonly userID: string;
	/** Opened through a view-only link: nothing is written (Zero mutations are no-ops). */
	readonly readOnly: boolean;
	userName = '';
	/** this user has a built-in agent provider set up (Settings) */
	agentConfigured = $state(false);
	/** a coding agent (Claude Code, Codex, …) has signed in over MCP */
	mcpConnected = $state(false);
	/** with neither, nothing can act on notes or build models */
	get agentReady() {
		return this.agentConfigured || this.mcpConnected;
	}
	engine: EngineClient | null = null;
	viewer: Viewer | null = null;
	/** Assemblies: joints, dragging, saved positions, interference. */
	readonly asm: AssemblyController = new AssemblyController(this);

	// ---- synced rows (set by the component from useQuery) ----
	doc = $state.raw<DocRow | null>(null);
	scripts = $state.raw<Script[]>([]);
	configurations = $state.raw<(Configuration & { overrides: ParamOverride[] })[]>([]);
	versions = $state.raw<Version[]>([]);
	notes = $state.raw<Note[]>([]);
	agents = $state.raw<AgentSession[]>([]);
	synced = $state(false);

	// ---- per-user view state ----
	activeConfigID = $state<string | null>(null); // null = Default (the code's values)
	mode = $state<'model' | 'code'>('model');
	leftTab = $state('parts');
	rightTab = $state('properties');
	tool = $state<Tool>('select');
	display = $state<'shaded' | 'shaded-edges' | 'wireframe' | 'hidden-line'>('shaded-edges');
	/** Orthographic projection (O); remembered per browser like the theme. */
	#ortho = $state(pref('parasocial:ortho', false));
	get ortho() {
		return this.#ortho;
	}
	set ortho(v: boolean) {
		this.#ortho = v;
		try {
			localStorage.setItem('parasocial:ortho', String(v));
		} catch {}
	}
	hidden = $state<string[]>([]);
	/**
	 * Isolate (Shift+H): only these parts and instances show; null when not isolated. A view layer
	 * over `hidden` that never writes to it, so leaving restores the visibility from before. Like
	 * `hidden`, it's per session and never synced.
	 */
	isolated = $state.raw<string[] | null>(null);
	/**
	 * The studio shown in the viewport: one at a time, like a CAD document's tabs. An assembly
	 * studio shows its own copies of the parts it joins. Remembered per document; null = the first.
	 */
	activeStudio = $state<string | null>(null);
	openScript = $state<string | null>(null);
	/** Section view (S): axis, offset along it (mm), flipped. */
	/** Axis-aligned section, or 'Face': through a planar face's plane (offset along its outward normal). */
	section = $state<{ axis: 'X' | 'Y' | 'Z' | 'Face'; offset: number; flip: boolean; plane?: { origin: number[]; normal: number[] } } | null>(null);
	/** Build animation (A): progress 0..1, playing, looping, playback speed (remembered per browser). Just for show. */
	build = $state<{ t: number; playing: boolean; loop: boolean; speed: number } | null>(null);
	/** Ground grid and origin triad (G, Shift+G); remembered per browser. */
	showGrid = $state(pref('parasocial:grid', true));
	showOrigin = $state(pref('parasocial:origin', true));
	revealLine = $state<number | null>(null);

	// ---- engine-derived metadata ----
	/** The parts the scripts export, as last discovered by the engine (remembered per document for cache-first open). */
	partInfos = $state.raw<PartInfo[]>([]);
	results = $state.raw<Record<string, PartMeta>>({});
	regen = $state<Record<string, RegenState>>({});
	kernelReady = $state(false);
	engineInfo = $state.raw<EngineInfo | null>(null);
	engineError = $state<string | null>(null);

	// ---- selection ----
	#additiveSelection = $state(pref('parasocial:additiveSelection', false));
	get additiveSelection() {
		return this.#additiveSelection;
	}
	set additiveSelection(value: boolean) {
		this.#additiveSelection = value;
		try {
			localStorage.setItem('parasocial:additiveSelection', String(value));
		} catch {}
	}
	selection = $state.raw<EntityRef[]>([]);
	/** Scope selected in the Parts tree; geometry selection still contains its individual bodies. */
	assemblySelection = $state<string | null>(null);
	hover = $state.raw<EntityRef | null>(null);

	// ---- live param scrubbing (not committed yet) ----
	live = $state.raw<Record<string, Record<string, string | number>>>({});
	scrubbing = $state(false);
	typing = $state(false);

	// ---- Code mode buffers (unsaved edits preview live, §8 Code mode) ----
	buffers = $state.raw<Record<string, { content: string; base: number; baseContent: string }>>({});
	/** Remote changes that arrived while a buffer was dirty: path -> who changed it. */
	conflicts = $state.raw<Record<string, string>>({});
	get dirty(): string[] {
		return Object.entries(this.buffers)
			.filter(([, b]) => b.content !== b.baseContent)
			.map(([p]) => p);
	}

	// ---- undo ----
	undoStack = $state.raw<Undo[]>([]);
	redoStack = $state.raw<Undo[]>([]);

	private presenceID = newID();
	private presenceTimer: any = null;
	private sentScripts = new Map<string, string>();
	private sentOverrides = new Map<string, string>();
	private docSent = false;
	private cacheFirstDone = false;

	constructor(o: { documentID: string; zero: ParasocialZero; userID: string; readOnly?: boolean }) {
		this.documentID = o.documentID;
		this.readOnly = !!o.readOnly;
		this.zero = this.readOnly ? readOnlyZero(o.zero) : o.zero;
		this.userID = o.userID;
		try {
			const saved = localStorage.getItem(`parasocial:config:${o.documentID}`);
			if (saved) this.activeConfigID = saved === 'default' ? null : saved;
			this.activeStudio = localStorage.getItem(`parasocial:studio:${o.documentID}`);
			this.partInfos = JSON.parse(localStorage.getItem(`parasocial:parts:${o.documentID}`) ?? '[]');
		} catch {}
	}

	// ---------- derived ----------
	/** Part ids in studio order. A studio the engine hasn't loaded yet counts as one part named after the file. */
	get parts(): string[] {
		return this.partTree.flatMap((g) => g.parts.map((p) => p.id));
	}

	/**
	 * Parts grouped under the studio that exports them (Parts tab tree), in path order; `name` is
	 * the studio's display name, `description` its description export (else its one assembly's
	 * description). A studio exports parts or assemblies, not both (the engine
	 * rejects a mix); an assembly studio comes with its instances. `ids` is what the viewport
	 * shows while the studio is active: its parts, or its instances.
	 */
	get partTree(): { file: string; name: string; description?: string; parts: PartInfo[]; assemblies: AssemblyInfo[]; instances: AssemblyInstance[]; ids: string[] }[] {
		return this.scripts
			.map((s) => s.path)
			.filter((p) => /^studios\/[^/]+\.ts$/.test(p))
			.sort()
			.map((file) => {
				const known = this.partInfos.filter((p) => p.file === file);
				const stem = file.slice('studios/'.length, -'.ts'.length);
				// part lists remembered before studios had names lack `studio`
				const assemblies = this.asm.assemblies.filter((a) => a.file === file);
				const name = known[0]?.studio ?? assemblies[0]?.studio ?? stem;
				const description = known[0]?.studioDescription ?? assemblies[0]?.studioDescription ?? (assemblies.length === 1 ? assemblies[0].description : undefined);
				const parts = known.length || assemblies.length ? known : [{ id: stem, file, export: 'default', name: stem, studio: stem }];
				const instances = assemblies.flatMap((a) => a.instances);
				const ids = [...parts.map((p) => p.id), ...instances.map((i) => i.id)];
				return { file, name, description, assemblies, parts, instances, ids };
			});
	}

	/** The studio shown in the viewport (the remembered one, else the first). */
	get studio() {
		const tree = this.partTree;
		return tree.find((g) => g.file === this.activeStudio) ?? tree[0] ?? null;
	}

	/** Ids in the viewport: the active studio's parts, or an assembly studio's instances. */
	get shownParts(): string[] {
		return this.studio?.ids ?? [];
	}

	/** The parts whose geometry is on screen (an instance counts as its source part). */
	get shownSources(): string[] {
		return [...new Set(this.shownParts.map(sourcePart))];
	}

	/** Every assembly instance in the document. */
	get instances(): AssemblyInstance[] {
		return this.asm.assemblies.flatMap((a) => a.instances);
	}

	/** Every id something can be selected or pinned on: parts and assembly instances. */
	get allParts(): string[] {
		return [...this.parts, ...this.instances.map((i) => i.id)];
	}

	/** A part's copies in assemblies. */
	copiesOf(part: string): string[] {
		return this.instances.filter((i) => i.part === part).map((i) => i.id);
	}

	/** The studio a part or instance is shown in. */
	studioOf(id: string): string | undefined {
		return this.partTree.find((g) => g.ids.includes(id))?.file;
	}

	/** Show one studio in the viewport (selection outside it is dropped). */
	setActiveStudio(file: string) {
		if (this.studio?.file === file) return;
		// isolation is of the studio's own parts
		this.exitIsolate();
		this.activeStudio = file;
		try {
			localStorage.setItem(`parasocial:studio:${this.documentID}`, file);
		} catch {}
		this.showStudio();
	}

	/**
	 * Put the active studio's geometry in the viewer and take everything else out. Idempotent;
	 * called when the studio changes and whenever its list of parts may have.
	 */
	showStudio() {
		const v = this.viewer;
		if (!v) return;
		const shown = new Set(this.shownParts);
		for (const id of v.partIds()) if (!shown.has(id)) v.removePart(id);
		const present = new Set(v.partIds());
		for (const id of shown) if (!present.has(id)) this.paint(id);
		const sel = this.selection.filter((r) => shown.has(r.part));
		if (sel.length !== this.selection.length) this.select(sel);
		if (this.hover && !shown.has(this.hover.part)) this.hover = null;
		this.asm.check();
	}

	/** The studio script a part comes from. */
	scriptOf(part: string): string {
		return this.partInfos.find((p) => p.id === part)?.file ?? `studios/${part.split(':')[0]}.ts`;
	}

	private setPartInfos(infos: PartInfo[]) {
		this.partInfos = infos;
		try {
			localStorage.setItem(`parasocial:parts:${this.documentID}`, JSON.stringify(infos));
		} catch {}
	}

	get activeConfig() {
		return this.configurations.find((c) => c.id === this.activeConfigID) ?? null;
	}

	/** Overrides for a part in the active configuration (committed + live scrub values). */
	overridesFor(part: string): Record<string, string | number> {
		const out: Record<string, string | number> = {};
		for (const o of this.activeConfig?.overrides ?? []) if (o.part === part) out[o.name] = o.expression;
		Object.assign(out, this.live[part] ?? {});
		return out;
	}

	/** Everything a part's geometry depends on besides scripts: its overrides and the shared ones. */
	private cacheOverrides(part: string): Record<string, string | number> {
		const out = { ...this.overridesFor(part) };
		for (const [k, v] of Object.entries(this.overridesFor(SHARED))) out[`${SHARED}${k}`] = v;
		return out;
	}

	partColor(part: string, dark: boolean): string {
		const r = this.results[part];
		if (r?.color?.kind === 'rgb') return r.color.hex;
		const c = partColorAt(Math.max(0, this.parts.indexOf(sourcePart(part))));
		return dark ? c.dark : c.light;
	}

	/** Regeneration results of the parts (instances repeat their source part's, so they're left out). */
	get partResults(): PartMeta[] {
		return this.parts.flatMap((p) => this.results[p] ?? []);
	}

	get problems() {
		return this.partResults.flatMap((r) => r.problems.map((p) => ({ ...p, part: r.part })));
	}

	setActiveConfig(id: string | null) {
		this.activeConfigID = id;
		this.publishPresence();
		try {
			localStorage.setItem(`parasocial:config:${this.documentID}`, id ?? 'default');
		} catch {}
	}

	// ---------- engine sync ----------
	attachEngine(engine: EngineClient) {
		this.engine = engine;
		engine.ready.then(
			(info) => {
				this.kernelReady = true;
				this.engineInfo = info;
				try {
					localStorage.setItem(BUILD_KEY, info.build);
				} catch {}
			},
			(e) => (this.engineError = String(e?.message ?? e))
		);
	}

	/**
	 * Push script/override changes to the engine and regenerate what changed. Called from an
	 * effect whenever the synced rows or live overrides change. Regeneration is latest-wins in
	 * the engine, so rapid changes never queue up.
	 */
	async sync() {
		const engine = this.engine;
		if (!engine || !this.synced) return;
		const scripts = Object.fromEntries(this.scripts.map((s) => [s.path, s.content]));
		// unsaved buffers preview live (typing regenerates coarse, then refines)
		for (const [p, b] of Object.entries(this.buffers)) if (b.content !== b.baseContent) scripts[p] = b.content;
		const quality = this.scrubbing || this.typing ? 'coarse' : 'fine';
		if (!this.cacheFirstDone) {
			this.cacheFirstDone = true;
			this.cacheFirst(scripts, this.parts);
		}
		const toRegen = new Set<string>();
		let parts: string[];
		if (!this.docSent) {
			this.docSent = true;
			// overrides for every part that has any (the part list comes back from the engine)
			const ids = new Set([...this.parts, SHARED, ...(this.activeConfig?.overrides ?? []).map((o) => o.part), ...Object.keys(this.live)]);
			const overrides = Object.fromEntries([...ids].map((p) => [p, this.overridesFor(p)]));
			this.setPartInfos(await engine.setDocument({ scripts, overrides, units: { length: this.doc?.units ?? 'mm', angle: 'deg' } }));
			// before listing parts: a studio that only exports an assembly has none
			await this.asm.refresh();
			for (const [k, v] of Object.entries(scripts)) this.sentScripts.set(k, v);
			for (const p of ids) this.sentOverrides.set(p, JSON.stringify(overrides[p]));
			parts = this.parts;
			parts.forEach((p) => toRegen.add(p));
		} else {
			const changed: string[] = [];
			let infos: PartInfo[] | null = null;
			for (const [path, content] of Object.entries(scripts)) {
				if (this.sentScripts.get(path) !== content) {
					this.sentScripts.set(path, content);
					infos = await engine.setScript(path, content);
					changed.push(path);
				}
			}
			for (const path of [...this.sentScripts.keys()]) {
				if (!(path in scripts)) {
					this.sentScripts.delete(path);
					infos = await engine.setScript(path, null);
					changed.push(path);
				}
			}
			const before = new Map(this.partInfos.map((p) => [p.id, JSON.stringify(p)]));
			if (infos) this.setPartInfos(infos);
			if (changed.length) await this.asm.refresh();
			parts = this.parts;
			if (changed.length) {
				// only what reads a changed script (or looked for a missing one); the rest keep their results
				for (const p of await engine.affected(changed)) toRegen.add(p);
				// new parts, and parts that moved to another file or export
				for (const p of this.partInfos) if (before.get(p.id) !== JSON.stringify(p) || !this.results[p.id]) toRegen.add(p.id);
			}
			for (const p of parts) {
				const o = this.overridesFor(p);
				const s = JSON.stringify(o);
				if (this.sentOverrides.get(p) !== s) {
					this.sentOverrides.set(p, s);
					await engine.setOverrides(p, o);
					toRegen.add(p);
				}
			}
			// shared params: one set of overrides, read by every part that declares them
			const so = this.overridesFor(SHARED);
			const ss = JSON.stringify(so);
			if (this.sentOverrides.get(SHARED) !== ss) {
				this.sentOverrides.set(SHARED, ss);
				await engine.setOverrides(SHARED, so);
				for (const p of parts) if (!this.results[p] || this.results[p].params.some((d) => d.shared)) toRegen.add(p);
			}
			// Only source parts belong to this list. Assembly copies are reconciled by syncInstances;
			// treating them as deleted here unmounts every copy, including ones that won't regenerate.
			for (const p of Object.keys(this.results)) if (sourcePart(p) === p && !parts.includes(p)) this.dropPart(p);
		}
		// progressive meshing: a settled fine pass after scrubbing ends
		if (!this.scrubbing && !this.typing) for (const p of parts) if (this.results[p]?.quality === 'coarse') toRegen.add(p);
		for (const p of toRegen) this.regenerate(p, quality);
	}

	/** Re-show the live geometry for every part (e.g. after viewing an old version). */
	async refreshAll() {
		await Promise.all(this.parts.map((p) => this.regenerate(p, 'fine')));
	}

	private regenerations = new Map<string, symbol>();

	private async regenerate(part: string, quality: 'coarse' | 'fine', reuse = true): Promise<void> {
		const engine = this.engine!;
		const request = Symbol();
		this.regenerations.set(part, request);
		this.regen = { ...this.regen, [part]: 'running' };
		try {
			// the geometry on screen at this quality: an edit elsewhere usually leaves it as is
			const prev = this.results[part];
			const known = reuse && prev?.key && prev.quality === quality && this.meshes.has(part) ? prev.key : undefined;
			const r = await engine.regenerate(part, quality, known);
			if (!r || this.regenerations.get(part) !== request) return;
			if (r.unchanged) {
				// something else landed meanwhile: what we said we had is gone, fetch the mesh after all
				const now = this.results[part];
				if (now?.key !== r.key || now.quality !== r.quality || !this.meshes.has(part)) return await this.regenerate(part, quality, false);
				this.applyUnchanged(r);
			} else this.applyResult(r, false);
			if (r.ok && quality === 'fine') {
				const { names: _, fromCache: __, ...meta } = this.results[part] ?? r;
				this.writeCache(r.unchanged ? meta : r);
			}
		} catch (e) {
			if (this.regenerations.get(part) !== request) return;
			const err = e as Error & { timeout?: boolean };
			this.setMeta(part, {
				...(this.results[part] ?? emptyMeta(part)),
				ok: false,
				partial: true,
				problems: [{ severity: 'error', kind: err.timeout ? 'timeout' : 'runtime', message: err.message, part }]
			});
		} finally {
			if (this.regenerations.get(part) === request) {
				this.regenerations.delete(part);
				this.regen = { ...this.regen, [part]: 'idle' };
			}
		}
	}

	private applyResult(r: CachedPart, fromCache: boolean) {
		const { mesh, ...meta } = r;
		const prev = this.results[r.part];
		// a script that doesn't load has no name: keep the last known one
		if (!r.ok && prev && meta.name === r.part) meta.name = prev.name;
		this.setMeta(r.part, { ...meta, names: r.names ?? (prev?.key === meta.key ? prev?.names : undefined), fromCache });
		if (mesh) this.meshes.set(r.part, mesh);
		else this.meshes.delete(r.part);
		if (this.viewer) {
			// discrete changes (someone else's write, a restore) cross-fade; our own scrubbing/typing swaps instantly
			const crossfade = !fromCache && !!prev && !this.scrubbing && !this.typing && prev.key !== meta.key && r.quality === 'fine' && prev.quality === 'fine';
			for (const id of [r.part, ...this.copiesOf(r.part)]) if (this.shownParts.includes(id)) this.paint(id, crossfade);
			// selections on a part that changed shape keep their indices only if still valid (viewer prunes)
			this.selection = this.viewer.getSelection();
		}
		// connectors may have moved with the geometry; overlaps certainly may have
		if (!fromCache) this.asm.rebuild();
	}

	/**
	 * Same geometry as on screen, fresh everything else (params, problems, color …): keep the mesh,
	 * its entity metadata and the viewer's part, and only touch what actually changed.
	 */
	private applyUnchanged(r: PartResult) {
		const prev = this.results[r.part];
		if (!prev) return;
		const { mesh: _, unchanged: __, ...fresh } = r;
		const density = r.material?.density ?? 1;
		const meta: PartMeta = {
			...fresh,
			faces: prev.faces,
			edges: prev.edges,
			vertices: prev.vertices,
			faceEdges: prev.faceEdges,
			bbox: prev.bbox,
			// the material may have changed without the shape
			mass: prev.mass && { ...prev.mass, mass: (prev.mass.volume / 1000) * density },
			names: prev.names,
			fromCache: false
		};
		if (!r.ok && meta.name === r.part) meta.name = prev.name;
		this.setMeta(r.part, meta);
		const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
		if (this.viewer) {
			const repaint = prev.ok !== meta.ok || prev.fromCache || !same(prev.color, meta.color) || !same(prev.appearance, meta.appearance);
			const errors = !same(prev.problems, meta.problems);
			for (const id of [r.part, ...this.copiesOf(r.part)]) {
				if (!this.shownParts.includes(id)) continue;
				if (repaint) this.paint(id);
				else if (errors) this.highlightErrors(this.results[id]);
			}
		}
		if (prev.fromCache || prev.name !== meta.name || !same(prev.connectors, meta.connectors)) this.asm.rebuild();
	}

	/** A part's metadata, repeated for its copies in assemblies (same geometry, their own ids and names). */
	private setMeta(part: string, meta: PartMeta) {
		const next = { ...this.results, [part]: meta };
		for (const i of this.instances) if (i.part === part) next[i.id] = this.copyMeta(i, meta);
		this.results = next;
	}

	/**
	 * A copy's metadata: its part's, under its own id, named after the copy ("Wheel fl") and the
	 * inserted assemblies it's in ("Corner left › Wheel").
	 */
	private copyMeta(i: AssemblyInstance, meta: PartMeta): PartMeta {
		const own = i.name === undefined ? meta.name : `${meta.name} ${i.name}`;
		const scope = this.scopeLabel(i.scope);
		return { ...meta, part: i.id, name: scope ? `${scope} › ${own}` : own };
	}

	/** The inserted assemblies a scope is inside, for display ("Axle front › Corner left"); null for an assembly itself. */
	scopeLabel(scope: string): string | null {
		const asm = this.asm.assemblies.find((a) => scope.startsWith(`${a.id}/`));
		const out: string[] = [];
		for (let s = scope; asm && s !== asm.id; ) {
			const sub = asm.subs.find((x) => x.id === s);
			if (!sub) break;
			const label = this.asm.assemblies.find((a) => a.id === sub.assembly)?.name ?? sub.assembly;
			out.unshift(sub.name === undefined ? label : `${label} ${sub.name}`);
			s = sub.parent;
		}
		return out.length ? out.join(' › ') : null;
	}

	/** Assemblies changed: give new instances their source part's metadata, drop removed ones. */
	syncInstances() {
		const ids = new Set(this.instances.map((i) => i.id));
		let next: Record<string, PartMeta> | null = null;
		for (const id of Object.keys(this.results)) if (sourcePart(id) !== id && !ids.has(id)) delete (next ??= { ...this.results })[id];
		for (const i of this.instances) {
			const r = this.results[i.part];
			if (!r) continue;
			const cur = this.results[i.id];
			const meta = this.copyMeta(i, r);
			if (cur?.key !== r.key || cur.name !== meta.name) (next ??= { ...this.results })[i.id] = meta;
		}
		if (next) this.results = next;
		this.showStudio();
	}

	/**
	 * Every part's latest mesh, by source part id. Only the active studio is in the viewer, so the
	 * meshes live here: switching studios or remounting the viewport repaints from them.
	 */
	private meshes = new Map<string, Mesh>();

	/** Show a part or instance in the viewer from its metadata and its source part's mesh. */
	private paint(id: string, crossfade = false) {
		const v = this.viewer;
		const r = this.results[id];
		const mesh = this.meshes.get(sourcePart(id));
		if (!v) return;
		if (!r || !mesh) return void v.removePart(id);
		const dark = document.documentElement.dataset.theme === 'dark';
		v.setPart({
			id,
			mesh,
			faceEdges: r.faceEdges,
			vertices: r.vertices,
			hiddenEdges: new Set(r.edges.flatMap((e, i) => (e.seam || e.smooth ? [i] : []))),
			color: this.partColor(id, dark),
			appearance: r.appearance,
			dim: !r.ok
		}, { crossfade });
		v.setVisible(id, this.isShown(id));
		this.highlightErrors(r);
	}

	/** A remounted viewport (HMR, re-entering the page) gets the old viewer's camera. */
	private stash: { camera: ReturnType<Viewer['cameraState']> } | null = null;

	detachViewer() {
		const v = this.viewer;
		if (!v) return;
		this.stash = { camera: v.cameraState() };
		this.viewer = null;
	}

	/** Returns true when the view was restored from a previous viewer (no initial fit needed). */
	attachViewer(v: Viewer): boolean {
		this.viewer = v;
		const stash = this.stash;
		this.stash = null;
		this.showStudio();
		if (!stash) return false;
		if (this.selection.length) v.setSelection(this.selection);
		v.setCameraState(stash.camera, false);
		this.asm.attach();
		return this.meshes.size > 0;
	}

	private async highlightErrors(r: PartResult) {
		const hl = r.problems.find((p) => p.highlight)?.highlight;
		if (!hl || !this.engine || !this.viewer) {
			this.viewer?.setPartErrors(r.part, []);
			return;
		}
		const refs: EntityRef[] = [];
		for (const n of hl.names) for (const index of await this.engine.indexOfName(r.part, hl.kind, n)) refs.push({ part: r.part, kind: hl.kind, index });
		this.viewer?.setPartErrors(r.part, refs);
	}

	private dropPart(p: string) {
		// A result already in flight must not resurrect a deleted source part.
		this.regenerations.delete(p);
		const { [p]: _regen, ...regen } = this.regen;
		this.regen = regen;
		const { [p]: _, ...rest } = this.results;
		for (const id of this.copiesOf(p)) delete rest[id];
		this.results = rest;
		this.meshes.delete(p);
		for (const id of [p, ...this.copiesOf(p)]) this.viewer?.removePart(id);
	}

	/** A part's mesh as last regenerated (instances: their source part's). */
	meshOf(id: string): Mesh | undefined {
		return this.meshes.get(sourcePart(id));
	}

	/** Paint the viewport from cached derived data before the kernel is ready (§9 cache-first open). */
	private async cacheFirst(scripts: Record<string, string>, parts: string[]) {
		const build = localStorage.getItem(BUILD_KEY);
		if (!build || typeof caches === 'undefined') return;
		const cache = await caches.open(DERIVED_CACHE);
		await Promise.all(
			parts.map(async (part) => {
				const key = await derivedKey({ part, scripts, overrides: this.cacheOverrides(part), build });
				const res = await cache.match(`/derived/${key}`);
				if (!res || this.results[part]) return;
				const r = unpackResult(await res.arrayBuffer());
				if (r && !this.results[part]) this.applyResult(r, true);
			})
		);
	}

	private async writeCache(r: PartResult) {
		try {
			const build = this.engineInfo?.build;
			if (!build || !this.engine || typeof caches === 'undefined') return;
			const names = await this.engine.names(r.part);
			const scripts = Object.fromEntries(this.sentScripts);
			const key = await derivedKey({ part: r.part, scripts, overrides: this.cacheOverrides(r.part), build });
			const meta = this.results[r.part];
			if (meta?.key === r.key) this.setMeta(r.part, { ...meta, names: { face: names.face, edge: names.edge } });
			const cache = await caches.open(DERIVED_CACHE);
			// the result's mesh was transferred out; this is the same one
			const mesh = this.meshes.get(r.part);
			if (!mesh) return;
			await cache.put(`/derived/${key}`, new Response(packResult({ ...r, mesh, names: { face: names.face, edge: names.edge } })));
		} catch {}
	}

	// ---------- mutations (with undo) ----------
	private recordUndo(entry: Undo) {
		this.undoStack = [...this.undoStack.slice(-99), entry];
		this.redoStack = [];
	}

	async mutate(mr: AnyMR, label: string) {
		if (this.readOnly) return this.zero.mutate(mr as any);
		const read = ((q: any) => this.zero.run(q)) as any;
		const inverse = await captureInverse(read, mr).catch(() => null);
		const res = this.zero.mutate(mr as any);
		if (inverse?.length) {
			this.recordUndo({ kind: 'mutation', undo: inverse, redo: [mr], label });
		}
		return res;
	}

	/** Apply an entry and capture the inverse for the opposite stack. */
	private async replay(entry: Undo): Promise<Undo> {
		if (entry.kind === 'visibility') {
			const inverse = entry.undo.map(({ part }) => ({ part, hidden: this.hidden.includes(part) }));
			this.applyVisibility(entry.undo);
			return { ...entry, undo: inverse, redo: entry.undo };
		}
		const read = ((q: any) => this.zero.run(q)) as any;
		const inverse = (await captureInverseAll(read, entry.undo).catch(() => null)) ?? entry.redo;
		for (const m of entry.undo) this.zero.mutate(m as any);
		return { ...entry, undo: inverse, redo: entry.undo };
	}

	async undo() {
		const e = this.undoStack.at(-1);
		if (!e) return null;
		this.undoStack = this.undoStack.slice(0, -1);
		const inverse = await this.replay(e);
		this.redoStack = [...this.redoStack, inverse];
		return e.label;
	}

	async redo() {
		const e = this.redoStack.at(-1);
		if (!e) return null;
		this.redoStack = this.redoStack.slice(0, -1);
		const inverse = await this.replay(e);
		this.undoStack = [...this.undoStack, inverse];
		return e.label;
	}

	/** Overrides need a named configuration: editing a param on Default creates "Custom". */
	async ensureConfiguration(): Promise<string> {
		if (this.activeConfigID) return this.activeConfigID;
		const existing = this.configurations.find((c) => c.name === 'Custom');
		if (existing) {
			this.setActiveConfig(existing.id);
			return existing.id;
		}
		const id = newID();
		await this.mutate(mutators.configuration.create({ id, documentID: this.documentID, name: 'Custom', overrides: [] }), 'Create configuration').then((r) => r.client);
		this.setActiveConfig(id);
		return id;
	}

	async setParam(part: string, name: string, expression: string, value: number | string, opts: { codeDefault?: string; rebase?: boolean } = {}) {
		// view only: a param tweak previews locally and is never saved
		if (this.readOnly) return void (this.live = { ...this.live, [part]: { ...(this.live[part] ?? {}), [name]: value } });
		const configurationID = await this.ensureConfiguration();
		const { [name]: _, ...restLive } = this.live[part] ?? {};
		this.live = { ...this.live, [part]: restLive };
		const decl = part === SHARED ? this.partResults.flatMap((r) => r.params).find((p) => p.shared && p.name === name) : this.results[part]?.params.find((p) => p.name === name);
		const codeDefault = opts.codeDefault ?? (decl ? String(decl.default) : undefined);
		return this.mutate(mutators.param.set({ documentID: this.documentID, configurationID, part, name, expression, value, codeDefault, rebase: opts.rebase } as any), `Set ${name}`);
	}

	async resetParam(part: string, name: string) {
		this.endScrub();
		const { [name]: _, ...rest } = this.live[part] ?? {};
		this.live = { ...this.live, [part]: rest };
		if (this.readOnly || !this.activeConfigID) return;
		return this.mutate(mutators.param.reset({ documentID: this.documentID, configurationID: this.activeConfigID, part, name } as any), `Reset ${name}`);
	}

	async resetAll(part?: string) {
		if (this.readOnly) return void (this.live = part ? { ...this.live, [part]: {} } : {});
		if (!this.activeConfigID) return;
		return this.mutate(mutators.param.resetAll({ documentID: this.documentID, configurationID: this.activeConfigID, part }), part ? `Reset ${part}` : 'Reset all');
	}

	/** Live value while scrubbing: regenerates coarse, commits nothing. */
	scrub(part: string, name: string, value: number) {
		this.scrubbing = true;
		this.live = { ...this.live, [part]: { ...(this.live[part] ?? {}), [name]: value } };
	}

	endScrub() {
		this.scrubbing = false;
	}

	// ---------- Code mode ----------
	openBuffer(path: string) {
		if (this.buffers[path]) return this.buffers[path];
		const sc = this.scripts.find((x) => x.path === path);
		if (!sc) return null;
		this.buffers = { ...this.buffers, [path]: { content: sc.content, base: sc.version, baseContent: sc.content } };
		return this.buffers[path];
	}

	editBuffer(path: string, content: string) {
		const b = this.buffers[path];
		if (!b) return;
		this.buffers = { ...this.buffers, [path]: { ...b, content } };
	}

	/** ⌘S: save creates a version; that's when other clients and agents see the change. */
	async saveBuffer(path: string) {
		const b = this.buffers[path];
		if (!b || b.content === b.baseContent) return null;
		const content = b.content;
		const res = this.zero.mutate(mutators.script.write({ documentID: this.documentID, path, content, baseVersion: b.base, message: `Edit ${path.split('/').pop()}` } as any));
		const server = await res.server;
		if ((server as any)?.type === 'error' || (server as any)?.error) return (server as any).error?.message ?? 'Save failed';
		const sc = this.scripts.find((x) => x.path === path);
		this.buffers = { ...this.buffers, [path]: { content, base: sc?.content === content ? sc.version : b.base + 1, baseContent: content } };
		const { [path]: _, ...rest } = this.conflicts;
		this.conflicts = rest;
		return null;
	}

	/** A synced script changed: reload clean buffers silently, flag dirty ones. */
	reconcileBuffers() {
		let changed = false;
		const next = { ...this.buffers };
		const conflicts = { ...this.conflicts };
		for (const [path, b] of Object.entries(this.buffers)) {
			const sc = this.scripts.find((x) => x.path === path);
			if (!sc) continue;
			if (sc.version === b.base || sc.content === b.baseContent) {
				if (sc.version !== b.base) (next[path] = { ...b, base: sc.version }), (changed = true);
				continue;
			}
			// the synced row already has exactly this text (our own save landing): clean, no conflict
			if (b.content === sc.content) next[path] = { content: sc.content, base: sc.version, baseContent: sc.content };
			else if (b.content === b.baseContent) next[path] = { content: sc.content, base: sc.version, baseContent: sc.content };
			else if (!conflicts[path]) {
				const agent = sc.updatedByAgent ? this.agents.find((a) => a.id === sc.updatedByAgent) : null;
				conflicts[path] = agent ? agent.clientName : sc.updatedByUser === this.userID ? 'you (another tab)' : 'someone else';
			}
			changed = true;
		}
		if (changed) (this.buffers = next), (this.conflicts = conflicts);
	}

	/** Reload (discard my edits) or keep mine (my next save overwrites theirs). */
	resolveConflict(path: string, keep: boolean) {
		const sc = this.scripts.find((x) => x.path === path);
		const b = this.buffers[path];
		if (!sc || !b) return;
		this.buffers = { ...this.buffers, [path]: keep ? { content: b.content, base: sc.version, baseContent: sc.content } : { content: sc.content, base: sc.version, baseContent: sc.content } };
		const { [path]: _, ...rest } = this.conflicts;
		this.conflicts = rest;
	}

	// ---------- selection ----------
	/** User gestures follow the preference or modifier keys; explicit selection commands replace. */
	selectionMode(e: Pick<MouseEvent, 'shiftKey' | 'metaKey' | 'ctrlKey'>, additive: 'toggle' | 'add' = 'toggle'): 'replace' | 'toggle' | 'add' {
		return this.additiveSelection || e.shiftKey || e.metaKey || e.ctrlKey ? additive : 'replace';
	}

	select(refs: EntityRef[], mode: 'replace' | 'toggle' | 'add' = 'replace') {
		this.assemblySelection = null;
		let next: EntityRef[];
		const same = (a: EntityRef, b: EntityRef) => a.part === b.part && a.kind === b.kind && a.index === b.index;
		if (mode === 'replace') next = refs;
		else if (mode === 'add') next = [...this.selection, ...refs.filter((r) => !this.selection.some((s) => same(s, r)))];
		else {
			next = [...this.selection];
			for (const r of refs) {
				const i = next.findIndex((s) => same(s, r));
				if (i >= 0) next.splice(i, 1);
				else next.push(r);
			}
		}
		this.selection = next;
		this.viewer?.setSelection(next);
		this.publishPresence();
	}

	get selectedAssemblyScope() {
		const scope = this.assemblySelection ? findAssemblyScope(this.asm.assemblies, this.assemblySelection) : undefined;
		if (!scope || scope.instances.length !== this.selection.length || !scope.instances.every((i) => this.selection.some((s) => s.part === i.id && (s.kind as string) === 'part'))) return null;
		return scope;
	}

	/** Select a scope as one group; additive toggles never leave a partially selected group. */
	selectAssemblyScope(id: string, mode: 'replace' | 'toggle' | 'add' = 'replace') {
		const scope = findAssemblyScope(this.asm.assemblies, id);
		if (!scope) return;
		const refs = scope.instances.map((i) => ({ part: i.id, kind: 'part' as any, index: 0 }));
		const all = refs.every((r) => this.selection.some((s) => s.part === r.part && s.kind === r.kind));
		if (mode === 'toggle' && all) this.select(this.selection.filter((s) => !refs.some((r) => r.part === s.part)));
		else this.select(refs, mode === 'toggle' ? 'add' : mode);
		this.assemblySelection = id;
	}

	/** Keep browser activity discoverable even before the user selects any geometry. */
	touchPresence() {
		this.zero.mutate(mutators.presence.set({ id: this.presenceID, documentID: this.documentID }));
	}

	/** Share the selection (by stable name) and active configuration, so agents can get_selection. */
	publishPresence() {
		clearTimeout(this.presenceTimer);
		this.presenceTimer = setTimeout(async () => {
			const sel = this.selection;
			const entries: { kind: 'face' | 'edge' | 'vertex' | 'part'; name: string; part: string }[] = [];
			for (const r of sel.slice(0, 200)) {
				if ((r.kind as string) === 'part') entries.push({ kind: 'part', name: r.part, part: r.part });
				else {
					let name = this.results[r.part]?.names?.[r.kind as 'face' | 'edge']?.[r.index];
					if (!name && this.engine && this.kernelReady) name = (await this.engine.describe(r.part, r.kind, r.index).catch(() => null))?.name;
					if (name) entries.push({ kind: r.kind, name, part: r.part });
				}
			}
			if (sel !== this.selection) return;
			this.zero.mutate(mutators.presence.set({ id: this.presenceID, documentID: this.documentID, selection: entries, activeConfigurationID: this.activeConfigID }));
		}, 250);
	}

	clearSelection() {
		this.select([]);
	}

	setHidden(part: string, hidden: boolean) {
		this.setVisibility([{ part, hidden }]);
	}

	/** Whether a part shows in the viewport: not hidden, or while isolated, one of the isolated. */
	isShown(part: string) {
		return this.isolated ? this.isolated.includes(part) : !this.hidden.includes(part);
	}

	/** Show only these parts (shown in the viewport); hidden ones among them show too, while isolated. */
	isolate(parts: string[]) {
		const shown = new Set(this.shownParts);
		const ids = [...new Set(parts)].filter((p) => shown.has(p));
		if (!ids.length) return false;
		this.isolated = ids;
		this.refreshVisibility();
		return true;
	}

	/** Leave isolation: every part's visibility is what it was before (hidden stays hidden). */
	exitIsolate() {
		if (!this.isolated) return;
		this.isolated = null;
		this.refreshVisibility();
	}

	/** Shift+H: isolate the selected parts, or leave isolation. False when there was nothing to do. */
	toggleIsolate() {
		if (this.isolated) return (this.exitIsolate(), true);
		return this.isolate(this.selection.map((r) => r.part));
	}

	private refreshVisibility() {
		for (const id of this.shownParts) this.viewer?.setVisible(id, this.isShown(id));
		this.asm.check();
	}

	/**
	 * One visibility action, including multi-selection toggles and Show all. While isolated, hiding
	 * and showing change what's isolated instead (not undoable, like isolating), so leaving still
	 * restores the visibility from before.
	 */
	setVisibility(changes: Visibility[]) {
		if (this.isolated) {
			const isolated = new Set(this.isolated);
			for (const { part, hidden } of changes) {
				if (hidden) isolated.delete(part);
				else isolated.add(part);
			}
			this.isolated = [...isolated];
			return this.refreshVisibility();
		}
		const desired = new Map(changes.map(({ part, hidden }) => [part, hidden]));
		const redo = [...desired].filter(([part, hidden]) => this.hidden.includes(part) !== hidden).map(([part, hidden]) => ({ part, hidden }));
		if (!redo.length) return;
		const undo = redo.map(({ part }) => ({ part, hidden: this.hidden.includes(part) }));
		const action = redo.every((v) => v.hidden) ? 'Hide' : redo.every((v) => !v.hidden) ? 'Show' : 'Toggle visibility of';
		const target = redo.length === 1 ? (this.results[redo[0].part]?.name ?? redo[0].part) : `${redo.length} parts`;
		this.applyVisibility(redo);
		this.recordUndo({ kind: 'visibility', undo, redo, label: `${action} ${target}` });
	}

	private applyVisibility(changes: Visibility[]) {
		const hidden = new Set(this.hidden);
		for (const change of changes) {
			if (change.hidden) hidden.add(change.part);
			else hidden.delete(change.part);
		}
		this.hidden = [...hidden];
		// undoing a visibility change while isolated changes what shows after leaving
		for (const change of changes) this.viewer?.setVisible(change.part, this.isShown(change.part));
		this.asm.check();
	}

	/** Start a section at a planar face, using an axis when its normal is aligned to one. */
	sectionFromFace(plane: { origin: number[]; normal: number[] }) {
		const k = plane.normal.findIndex((c) => Math.abs(c) > 1 - 1e-6);
		this.build = null;
		this.section = k < 0
			? { axis: 'Face', offset: 0, flip: false, plane }
			: { axis: (['X', 'Y', 'Z'] as const)[k], offset: plane.origin[k], flip: plane.normal[k] < 0 };
	}

	/** Section on/off (S). Start at the selected planar face, otherwise restore the last settings. */
	toggleSection(center = 0) {
		if (this.section) return void (this.section = null);
		this.build = null;
		const plane = this.selection.length === 1 ? this.viewer?.facePlane(this.selection[0]) : null;
		if (plane) return this.sectionFromFace(plane);
		let last: any = null;
		try {
			last = JSON.parse(localStorage.getItem('parasocial:section') ?? 'null');
		} catch {}
		this.section = last && ['X', 'Y', 'Z'].includes(last.axis) && Number.isFinite(last.offset) ? { axis: last.axis, offset: last.offset, flip: !!last.flip } : { axis: 'Z', offset: center, flip: false };
	}

	/** Build animation on (playing from the start) or off. Takes the section's place. */
	toggleBuild() {
		if (this.build) return void (this.build = null);
		this.section = null;
		let speed = 1;
		try {
			speed = Number(localStorage.getItem('parasocial:buildSpeed')) || 1;
		} catch {}
		this.build = { t: 0, playing: true, loop: false, speed };
	}

	setBuildSpeed(speed: number) {
		if (this.build) this.build = { ...this.build, speed };
		try {
			localStorage.setItem('parasocial:buildSpeed', String(speed));
		} catch {}
	}

	/** Remember section settings (called whenever they change). */
	rememberSection() {
		if (!this.section || this.section.axis === 'Face') return;
		try {
			localStorage.setItem('parasocial:section', JSON.stringify(this.section));
		} catch {}
	}

	setHelpers(o: { grid?: boolean; origin?: boolean }) {
		if (o.grid !== undefined) this.showGrid = o.grid;
		if (o.origin !== undefined) this.showOrigin = o.origin;
		try {
			localStorage.setItem('parasocial:grid', String(this.showGrid));
			localStorage.setItem('parasocial:origin', String(this.showOrigin));
		} catch {}
		this.viewer?.setHelpers({ grid: this.showGrid, origin: this.showOrigin });
	}

	/**
	 * Keep the documents-list thumbnail current: once the committed geometry of a version newer
	 * than the thumbnail's has settled (every part regenerated fine, nothing unsaved or scrubbing,
	 * Default configuration), render it offscreen, upload, and record it. Idempotent; call often.
	 */
	#thumbTimer: ReturnType<typeof setTimeout> | undefined;
	#thumbBusy = false;
	refreshThumbnail() {
		clearTimeout(this.#thumbTimer);
		const d = this.doc;
		if (!d || !this.viewer || this.#thumbBusy || this.readOnly) return;
		if (d.thumbLight && (d.thumbVersion ?? -1) >= d.headVersion) return;
		const settled =
			this.parts.length > 0 &&
			this.parts.every((p) => this.regen[p] !== 'running' && this.results[p]?.quality === 'fine') &&
			this.parts.some((p) => this.results[p]?.ok) &&
			!this.scrubbing &&
			!this.typing &&
			this.activeConfigID === null &&
			!Object.keys(this.live).length &&
			!this.dirty.length;
		if (!settled) return;
		const version = d.headVersion;
		this.#thumbTimer = setTimeout(() => void this.#renderThumbnail(version), 1500);
	}

	async #renderThumbnail(version: number) {
		const v = this.viewer;
		if (!v || this.doc?.headVersion !== version) return;
		const parts = this.parts.flatMap((p) => {
			const r = this.results[p],
				mesh = this.meshes.get(p);
			if (!r?.ok || !mesh) return [];
			const hiddenEdges = new Set(r.edges.flatMap((e, i) => (e.seam || e.smooth ? [i] : [])));
			return [{ id: p, mesh, faceEdges: r.faceEdges, hiddenEdges, color: { light: this.partColor(p, false), dark: this.partColor(p, true) }, appearance: r.appearance }];
		});
		if (!parts.length) return;
		this.#thumbBusy = true;
		try {
			const { renderThumbnails } = await import('./thumbnail');
			const blobs = await renderThumbnails(parts);
			const upload = async (b: Blob) => {
				const res = await fetch(`/api/blobs?document=${encodeURIComponent(this.documentID)}`, { method: 'POST', body: b, headers: { 'Content-Type': 'image/webp' } });
				if (!res.ok) throw new Error(`thumbnail upload failed (${res.status})`);
				return ((await res.json()) as { hash: string }).hash;
			};
			const [light, dark] = await Promise.all([upload(blobs.light), upload(blobs.dark)]);
			// not an edit: straight to Zero, outside undo
			await this.zero.mutate(mutators.document.setThumbnail({ id: this.documentID, light, dark, version })).client;
		} catch (e) {
			console.warn('thumbnail', e);
		} finally {
			this.#thumbBusy = false;
		}
	}

	/** Recolor viewer parts for a theme change. */
	retheme(dark: boolean) {
		for (const p of this.shownParts) this.viewer?.setPartColor(p, this.partColor(p, dark));
	}

	untracked<T>(fn: () => T): T {
		return untrack(fn);
	}
}

/**
 * Zero for a view-only workspace: queries as usual, every mutation a no-op (so a local tweak, like
 * dragging an assembly joint, stays local, and a save reports why it didn't happen).
 */
function readOnlyZero(zero: ParasocialZero): ParasocialZero {
	const skipped = () => ({ client: Promise.resolve(), server: Promise.resolve({ type: 'error', error: { type: 'app', message: 'This document is view only' } }) });
	return new Proxy(zero, {
		get(target, key) {
			if (key === 'mutate') return skipped;
			const v = Reflect.get(target, key, target);
			return typeof v === 'function' ? v.bind(target) : v;
		}
	});
}

function emptyMeta(part: string): PartMeta {
	return { part, file: `studios/${part.split(':')[0]}.ts`, name: part, ok: false, partial: true, empty: true, problems: [], params: [], quality: 'fine', faces: [], edges: [], vertices: [], faceEdges: [], timings: { total: 0, script: 0, ops: 0, mesh: 0, cacheHits: 0, cacheMisses: 0 } };
}

function pref(key: string, fallback: boolean): boolean {
	try {
		const v = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
		return v === null ? fallback : v === 'true';
	} catch {
		return fallback;
	}
}
