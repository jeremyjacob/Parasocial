// Workspace state (§8): the synced document (Zero), the engine (regeneration), the viewer
// (geometry), selection, tools and undo. Geometry never enters Svelte state (§9): meshes go
// straight from the engine to the viewer; Svelte only sees lightweight metadata.
import { untrack } from 'svelte';
import type { Viewer, EntityRef } from '@parasocial/viewer';
import { mutators, captureInverse, captureInverseAll, type AnyMR, type ParasocialZero, type Script, type Configuration, type ParamOverride, type Version, type Note, type AgentSession, type Document as DocRow } from '@parasocial/sync';
import type { PartResult, EngineInfo } from '@parasocial/runtime/protocol';
import { packResult, unpackResult, derivedKey, type CachedPart } from '@parasocial/runtime/pack';
import type { EngineClient } from '@parasocial/runtime/browser/client';
import { partColorAt } from '$lib/styles/tokens';
import { newID } from '$lib/zero';

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
	engine: EngineClient | null = null;
	viewer: Viewer | null = null;

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
	ortho = $state(false);
	filters = $state<('face' | 'edge' | 'vertex' | 'part')[]>(['face', 'edge']);
	hidden = $state<string[]>([]);
	isolated = $state<string[]>([]);
	openScript = $state<string | null>(null);
	revealLine = $state<number | null>(null);

	// ---- engine-derived metadata ----
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

	// ---- undo ----
	undoStack = $state.raw<Undo[]>([]);
	redoStack = $state.raw<Undo[]>([]);

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
		} catch {}
	}

	// ---------- derived ----------
	get parts(): string[] {
		return this.scripts
			.map((s) => s.path)
			.filter((p) => /^parts\/[^/]+\.ts$/.test(p))
			.sort()
			.map((p) => p.slice(6, -3));
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
		const parts = this.parts;
		const quality = this.scrubbing ? 'coarse' : 'fine';
		if (!this.cacheFirstDone) {
			this.cacheFirstDone = true;
			this.cacheFirst(scripts, parts);
		}
		const toRegen = new Set<string>();
		if (!this.docSent) {
			this.docSent = true;
			const overrides = Object.fromEntries(parts.map((p) => [p, this.overridesFor(p)]));
			await engine.setDocument({ scripts, overrides, units: { length: this.doc?.units ?? 'mm', angle: 'deg' } });
			for (const [k, v] of Object.entries(scripts)) this.sentScripts.set(k, v);
			for (const p of parts) this.sentOverrides.set(p, JSON.stringify(overrides[p]));
			parts.forEach((p) => toRegen.add(p));
		} else {
			let scriptChanged = false;
			for (const [path, content] of Object.entries(scripts)) {
				if (this.sentScripts.get(path) !== content) {
					this.sentScripts.set(path, content);
					await engine.setScript(path, content);
					scriptChanged = true;
				}
			}
			for (const path of [...this.sentScripts.keys()]) {
				if (!(path in scripts)) {
					this.sentScripts.delete(path);
					await engine.setScript(path, null);
					scriptChanged = true;
				}
			}
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
		if (!this.scrubbing) for (const p of parts) if (this.results[p]?.quality === 'coarse') toRegen.add(p);
		for (const p of toRegen) this.regenerate(p, quality);
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
		this.results = { ...this.results, [r.part]: { ...meta, names: r.names ?? (prev?.key === meta.key ? prev?.names : undefined), fromCache } };
		if (this.viewer) {
			const dark = document.documentElement.dataset.theme === 'dark';
			if (mesh) {
				this.viewer.setPart({
					id: r.part,
					mesh,
					faceEdges: r.faceEdges,
					hiddenEdges: new Set(r.edges.flatMap((e, i) => (e.seam ? [i] : []))),
					color: this.partColor(r.part, dark),
					dim: !r.ok
				});
				this.viewer.setVisible(r.part, !this.hidden.includes(r.part));
			} else this.viewer.removePart(r.part);
			this.highlightErrors(r);
		}
		// selections on a part that changed shape keep their indices only if still valid (viewer prunes)
		if (this.viewer) this.selection = this.viewer.getSelection();
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
	}

	clearSelection() {
		this.select([]);
	}

	setHidden(part: string, hidden: boolean) {
		this.hidden = hidden ? [...new Set([...this.hidden, part])] : this.hidden.filter((p) => p !== part);
		this.viewer?.setVisible(part, !hidden);
	}

	isolate(part: string | null) {
		this.isolated = part && !(this.isolated.length === 1 && this.isolated[0] === part) ? [part] : [];
		this.viewer?.isolate(this.isolated);
		this.viewer?.fit(undefined, true);
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
	return { part, file: `parts/${part}.ts`, name: part, ok: false, partial: true, empty: true, problems: [], params: [], quality: 'fine', faces: [], edges: [], vertices: [], faceEdges: [], timings: { total: 0, script: 0, ops: 0, mesh: 0, cacheHits: 0, cacheMisses: 0 } };
}
