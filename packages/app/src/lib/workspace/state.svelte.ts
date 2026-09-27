// Workspace state (§8): the synced document (Zero), the engine (regeneration), the viewer
// (geometry), selection, tools and undo. Geometry never enters Svelte state (§9): meshes go
// straight from the engine to the viewer; Svelte only sees lightweight metadata.
import { untrack } from 'svelte';
import type { Viewer, EntityRef } from '@parasocial/viewer';
import { mutators, captureInverse, captureInverseAll, type AnyMR, type ParasocialZero, type Script, type Configuration, type ParamOverride, type Version, type Note, type AgentSession, type Document as DocRow } from '@parasocial/sync';
import type { PartResult, PartInfo, EngineInfo, AssemblyInfo } from '@parasocial/runtime/protocol';
import { packResult, unpackResult, derivedKey, type CachedPart } from '@parasocial/runtime/pack';
import type { EngineClient } from '@parasocial/runtime/browser/client';
import { partColorAt } from '$lib/styles/tokens';
import { newID } from '$lib/zero';
import { AssemblyController } from './assembly.svelte';

type Mesh = NonNullable<ReturnType<Viewer['meshOf']>>;

export type Tool = 'select' | 'note' | 'pencil' | 'measure';
export type PartMeta = Omit<PartResult, 'mesh'> & { names?: { face: string[]; edge: string[] }; fromCache?: boolean };
export type RegenState = 'idle' | 'running' | 'queued';
type Undo = { undo: AnyMR[]; redo: AnyMR[]; label: string };

const DERIVED_CACHE = 'parasocial-derived-v1';
const BUILD_KEY = 'parasocial:engineBuild';

export class WorkspaceState {
	readonly documentID: string;
	readonly zero: ParasocialZero;
	readonly userID: string;
	userName = '';
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
	isolated = $state<string[]>([]);
	openScript = $state<string | null>(null);
	/** Section view (S): axis, offset along it (mm), flipped. */
	/** Axis-aligned section, or 'Face': through a planar face's plane (offset along its outward normal). */
	section = $state<{ axis: 'X' | 'Y' | 'Z' | 'Face'; offset: number; flip: boolean; plane?: { origin: number[]; normal: number[] } } | null>(null);
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
	selection = $state.raw<EntityRef[]>([]);
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

	constructor(o: { documentID: string; zero: ParasocialZero; userID: string }) {
		this.documentID = o.documentID;
		this.zero = o.zero;
		this.userID = o.userID;
		try {
			const saved = localStorage.getItem(`parasocial:config:${o.documentID}`);
			if (saved) this.activeConfigID = saved === 'default' ? null : saved;
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
	 * the studio's display name. A studio's assemblies come along (a studio may export only those).
	 */
	get partTree(): { file: string; name: string; parts: PartInfo[]; assemblies: AssemblyInfo[] }[] {
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
				return { file, name, assemblies, parts: known.length || assemblies.length ? known : [{ id: stem, file, export: 'default', name: stem, studio: stem }] };
			});
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

	partColor(part: string, dark: boolean): string {
		const r = this.results[part];
		if (r?.color?.kind === 'rgb') return r.color.hex;
		const c = partColorAt(Math.max(0, this.parts.indexOf(part)));
		return dark ? c.dark : c.light;
	}

	get problems() {
		return Object.values(this.results).flatMap((r) => r.problems.map((p) => ({ ...p, part: r.part })));
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
			const ids = new Set([...this.parts, ...(this.activeConfig?.overrides ?? []).map((o) => o.part), ...Object.keys(this.live)]);
			const overrides = Object.fromEntries([...ids].map((p) => [p, this.overridesFor(p)]));
			this.setPartInfos(await engine.setDocument({ scripts, overrides, units: { length: this.doc?.units ?? 'mm', angle: 'deg' } }));
			// before listing parts: a studio that only exports an assembly has none
			await this.asm.refresh();
			for (const [k, v] of Object.entries(scripts)) this.sentScripts.set(k, v);
			for (const p of ids) this.sentOverrides.set(p, JSON.stringify(overrides[p]));
			parts = this.parts;
			parts.forEach((p) => toRegen.add(p));
		} else {
			let scriptChanged = false;
			let infos: PartInfo[] | null = null;
			for (const [path, content] of Object.entries(scripts)) {
				if (this.sentScripts.get(path) !== content) {
					this.sentScripts.set(path, content);
					infos = await engine.setScript(path, content);
					scriptChanged = true;
				}
			}
			for (const path of [...this.sentScripts.keys()]) {
				if (!(path in scripts)) {
					this.sentScripts.delete(path);
					infos = await engine.setScript(path, null);
					scriptChanged = true;
				}
			}
			if (infos) this.setPartInfos(infos);
			if (scriptChanged) await this.asm.refresh();
			parts = this.parts;
			if (scriptChanged) parts.forEach((p) => toRegen.add(p));
			for (const p of parts) {
				const o = this.overridesFor(p);
				const s = JSON.stringify(o);
				if (this.sentOverrides.get(p) !== s) {
					this.sentOverrides.set(p, s);
					await engine.setOverrides(p, o);
					toRegen.add(p);
				}
			}
			// parts that disappeared
			for (const p of Object.keys(this.results)) if (!parts.includes(p)) this.dropPart(p);
		}
		// progressive meshing: a settled fine pass after scrubbing ends
		if (!this.scrubbing && !this.typing) for (const p of parts) if (this.results[p]?.quality === 'coarse') toRegen.add(p);
		for (const p of toRegen) this.regenerate(p, quality);
	}

	/** Re-show the live geometry for every part (e.g. after viewing an old version). */
	async refreshAll() {
		await Promise.all(this.parts.map((p) => this.regenerate(p, 'fine')));
	}

	private async regenerate(part: string, quality: 'coarse' | 'fine') {
		const engine = this.engine!;
		this.regen = { ...this.regen, [part]: 'running' };
		try {
			const r = await engine.regenerate(part, quality);
			if (!r) return; // superseded: a newer request for this part is already running
			this.applyResult(r, false);
			if (r.ok && quality === 'fine') this.writeCache(r);
		} catch (e) {
			const err = e as Error & { timeout?: boolean };
			this.results = {
				...this.results,
				[part]: {
					...(this.results[part] ?? emptyMeta(part)),
					ok: false,
					partial: true,
					problems: [{ severity: 'error', kind: err.timeout ? 'timeout' : 'runtime', message: err.message, part }]
				}
			};
		} finally {
			this.regen = { ...this.regen, [part]: 'idle' };
		}
	}

	private applyResult(r: CachedPart, fromCache: boolean) {
		const { mesh, ...meta } = r;
		const prev = this.results[r.part];
		// a script that doesn't load has no name: keep the last known one
		if (!r.ok && prev && meta.name === r.part) meta.name = prev.name;
		this.results = { ...this.results, [r.part]: { ...meta, names: r.names ?? (prev?.key === meta.key ? prev?.names : undefined), fromCache } };
		if (this.viewer) {
			if (mesh) {
				// discrete changes (someone else's write, a restore) cross-fade; our own scrubbing/typing swaps instantly
				const crossfade = !fromCache && !!prev && !this.scrubbing && !this.typing && prev.key !== meta.key && r.quality === 'fine' && prev.quality === 'fine';
				this.paint(r, mesh, crossfade);
			} else this.viewer.removePart(r.part);
			this.highlightErrors(r);
		}
		// selections on a part that changed shape keep their indices only if still valid (viewer prunes)
		if (this.viewer) this.selection = this.viewer.getSelection();
		// connectors may have moved with the geometry; overlaps certainly may have
		if (!fromCache) this.asm.rebuild();
	}

	private paint(r: PartResult, mesh: Mesh, crossfade = false) {
		const dark = document.documentElement.dataset.theme === 'dark';
		this.viewer!.setPart({
			id: r.part,
			mesh,
			faceEdges: r.faceEdges,
			hiddenEdges: new Set(r.edges.flatMap((e, i) => (e.seam ? [i] : []))),
			color: this.partColor(r.part, dark),
			appearance: r.appearance,
			dim: !r.ok
		}, { crossfade });
		this.viewer!.setVisible(r.part, !this.hidden.includes(r.part));
	}

	/**
	 * Meshes are transferred into the viewer, so a remounted viewport (HMR, re-entering the page)
	 * can't be repainted from `results`: keep the old viewer's meshes and camera to hand over.
	 */
	private stash: { meshes: Map<string, Mesh>; camera: ReturnType<Viewer['cameraState']> } | null = null;

	detachViewer() {
		const v = this.viewer;
		if (!v) return;
		const meshes = new Map<string, Mesh>();
		for (const p of Object.keys(this.results)) {
			const m = v.meshOf(p);
			if (m) meshes.set(p, m);
		}
		this.stash = { meshes, camera: v.cameraState() };
		this.viewer = null;
	}

	/** Returns true when the view was restored from a previous viewer (no initial fit needed). */
	attachViewer(v: Viewer): boolean {
		this.viewer = v;
		const stash = this.stash;
		this.stash = null;
		if (!stash) return false;
		for (const [p, mesh] of stash.meshes) {
			const r = this.results[p];
			if (!r) continue;
			this.paint(r, mesh);
			this.highlightErrors(r);
		}
		if (this.isolated.length) v.isolate(this.isolated);
		if (this.selection.length) v.setSelection(this.selection);
		v.setCameraState(stash.camera, false);
		this.asm.attach();
		return stash.meshes.size > 0;
	}

	private async highlightErrors(r: PartResult) {
		const hl = r.problems.find((p) => p.highlight)?.highlight;
		if (!hl || !this.engine || !this.viewer) {
			this.viewer?.setPartErrors(r.part, []);
			return;
		}
		const refs: EntityRef[] = [];
		for (const n of hl.names) for (const index of await this.engine.indexOfName(r.part, hl.kind, n)) refs.push({ part: r.part, kind: hl.kind, index });
		this.viewer.setPartErrors(r.part, refs);
	}

	private dropPart(p: string) {
		const { [p]: _, ...rest } = this.results;
		this.results = rest;
		this.viewer?.removePart(p);
	}

	/** Paint the viewport from cached derived data before the kernel is ready (§9 cache-first open). */
	private async cacheFirst(scripts: Record<string, string>, parts: string[]) {
		const build = localStorage.getItem(BUILD_KEY);
		if (!build || typeof caches === 'undefined') return;
		const cache = await caches.open(DERIVED_CACHE);
		await Promise.all(
			parts.map(async (part) => {
				const key = await derivedKey({ part, scripts, overrides: this.overridesFor(part), build });
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
			const key = await derivedKey({ part: r.part, scripts, overrides: this.overridesFor(r.part), build });
			const meta = this.results[r.part];
			if (meta?.key === r.key) this.results = { ...this.results, [r.part]: { ...meta, names: { face: names.face, edge: names.edge } } };
			const cache = await caches.open(DERIVED_CACHE);
			// the mesh was transferred into the viewer; re-read it from the viewer's copy
			const mesh = this.viewer?.meshOf(r.part);
			if (!mesh) return;
			await cache.put(`/derived/${key}`, new Response(packResult({ ...r, mesh, names: { face: names.face, edge: names.edge } })));
		} catch {}
	}

	// ---------- mutations (with undo) ----------
	async mutate(mr: AnyMR, label: string) {
		const read = ((q: any) => this.zero.run(q)) as any;
		const inverse = await captureInverse(read, mr).catch(() => null);
		const res = this.zero.mutate(mr as any);
		if (inverse?.length) {
			this.undoStack = [...this.undoStack.slice(-99), { undo: inverse, redo: [mr], label }];
			this.redoStack = [];
		}
		return res;
	}

	async undo() {
		const e = this.undoStack.at(-1);
		if (!e) return null;
		this.undoStack = this.undoStack.slice(0, -1);
		const read = ((q: any) => this.zero.run(q)) as any;
		const redo = (await captureInverseAll(read, e.undo).catch(() => null)) ?? e.redo;
		for (const m of e.undo) this.zero.mutate(m as any);
		this.redoStack = [...this.redoStack, { undo: redo, redo: e.undo, label: e.label }];
		return e.label;
	}

	async redo() {
		const e = this.redoStack.at(-1);
		if (!e) return null;
		this.redoStack = this.redoStack.slice(0, -1);
		const read = ((q: any) => this.zero.run(q)) as any;
		const undo = (await captureInverseAll(read, e.undo).catch(() => null)) ?? e.redo;
		for (const m of e.undo) this.zero.mutate(m as any);
		this.undoStack = [...this.undoStack, { undo, redo: e.undo, label: e.label }];
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
		const configurationID = await this.ensureConfiguration();
		const { [name]: _, ...restLive } = this.live[part] ?? {};
		this.live = { ...this.live, [part]: restLive };
		const decl = this.results[part]?.params.find((p) => p.name === name);
		const codeDefault = opts.codeDefault ?? (decl ? String(decl.default) : undefined);
		return this.mutate(mutators.param.set({ documentID: this.documentID, configurationID, part, name, expression, value, codeDefault, rebase: opts.rebase } as any), `Set ${name}`);
	}

	async resetParam(part: string, name: string) {
		if (!this.activeConfigID) return;
		return this.mutate(mutators.param.reset({ documentID: this.documentID, configurationID: this.activeConfigID, part, name } as any), `Reset ${name}`);
	}

	async resetAll(part?: string) {
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
	select(refs: EntityRef[], mode: 'replace' | 'toggle' | 'add' = 'replace') {
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
		this.hidden = hidden ? [...new Set([...this.hidden, part])] : this.hidden.filter((p) => p !== part);
		this.viewer?.setVisible(part, !hidden);
		this.asm.check();
	}

	isolate(part: string | null) {
		this.isolated = part && !(this.isolated.length === 1 && this.isolated[0] === part) ? [part] : [];
		this.viewer?.isolate(this.isolated);
		this.asm.check();
	}

	/** Isolate a set of parts (a studio's parts); toggles off when exactly that set is isolated. */
	isolateMany(parts: string[]) {
		const same = this.isolated.length === parts.length && parts.every((p) => this.isolated.includes(p));
		this.isolated = same ? [] : [...parts];
		this.viewer?.isolate(this.isolated);
		this.asm.check();
	}

	/** Section on/off (S). Turning it on restores the last axis, offset and flip used. */
	toggleSection(center = 0) {
		if (this.section) return void (this.section = null);
		let last: any = null;
		try {
			last = JSON.parse(localStorage.getItem('parasocial:section') ?? 'null');
		} catch {}
		this.section = last && ['X', 'Y', 'Z'].includes(last.axis) && Number.isFinite(last.offset) ? { axis: last.axis, offset: last.offset, flip: !!last.flip } : { axis: 'Z', offset: center, flip: false };
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
		if (!d || !this.viewer || this.#thumbBusy) return;
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
				mesh = v.meshOf(p);
			if (!r?.ok || !mesh) return [];
			const hiddenEdges = new Set(r.edges.flatMap((e, i) => (e.seam ? [i] : [])));
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
		for (const p of this.parts) this.viewer?.setPartColor(p, this.partColor(p, dark));
	}

	untracked<T>(fn: () => T): T {
		return untrack(fn);
	}
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
