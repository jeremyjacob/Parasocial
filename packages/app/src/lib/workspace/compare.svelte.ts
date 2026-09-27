// Compare (§8) and read-only version viewing (§8 Versions). Other versions regenerate in the
// engine's snapshot instance; their meshes go straight to the viewer.
import { mutators, type Version } from '@parasocial/sync';
import type { PartResult } from '@parasocial/runtime/protocol';
import { newID } from '$lib/zero';
import type { WorkspaceState } from './state.svelte';

type VersionContents = { version: Version; scripts: Record<string, string> };

export class CompareController {
	/** Version shown as the "before" ghost. */
	against = $state<string | null>(null);
	blend = $state(0.5);
	loading = $state(false);
	error = $state<string | null>(null);
	/** Read-only version being viewed from History. */
	viewing = $state<string | null>(null);
	viewScripts = $state.raw<Record<string, string> | null>(null);
	private contents = new Map<string, VersionContents>();

	constructor(private ws: WorkspaceState) {}

	private async fetchVersion(id: string): Promise<VersionContents> {
		const hit = this.contents.get(id);
		if (hit) return hit;
		const res = await fetch(`/api/versions/${encodeURIComponent(id)}`);
		if (!res.ok) throw new Error(`couldn't load version (${res.status})`);
		const v = (await res.json()) as VersionContents;
		this.contents.set(id, v);
		return v;
	}

	private overridesIn(v: Version): Record<string, Record<string, string | number>> {
		const name = this.ws.activeConfig?.name;
		const cfg = v.snapshot.params.configurations.find((c) => c.name === name);
		const out: Record<string, Record<string, string | number>> = {};
		for (const o of cfg?.overrides ?? []) (out[o.part] ??= {})[o.name] = o.expression;
		return out;
	}

	private async regenerate(id: string, parts: string[]): Promise<Map<string, PartResult>> {
		const v = await this.fetchVersion(id);
		const out = new Map<string, PartResult>();
		const doc = { scripts: v.scripts, overrides: this.overridesIn(v.version) };
		for (const part of parts) {
			if (!(`parts/${part}.ts` in v.scripts)) continue;
			const r = await this.ws.engine!.regenerateSnapshot(`${id}:${this.ws.activeConfigID}`, doc, part);
			if (r?.mesh) out.set(part, r);
		}
		return out;
	}

	/** Compare the current geometry against `versionID` (default: the previous version). */
	async open(fromVersionID?: string) {
		const ws = this.ws;
		const vs = ws.versions; // newest first
		let id = fromVersionID;
		// from a thread's version link: compare that version against the one before it
		if (id) {
			const i = vs.findIndex((v) => v.id === id);
			id = vs[i + 1]?.id ?? id;
		} else id = vs[1]?.id ?? vs[0]?.id;
		if (!id) return;
		this.against = id;
		this.blend = 0.5;
		await this.load();
	}

	async load() {
		const ws = this.ws;
		if (!this.against || !ws.viewer || !ws.engine) return;
		this.loading = true;
		this.error = null;
		try {
			const res = await this.regenerate(this.against, ws.parts);
			ws.viewer.clearGhosts();
			for (const [part, r] of res) ws.viewer.setGhost(part, r.mesh!);
			ws.viewer.setBlend(this.blend);
		} catch (e) {
			this.error = (e as Error).message;
		} finally {
			this.loading = false;
		}
	}

	setBlend(t: number) {
		this.blend = t;
		this.ws.viewer?.setBlend(t);
	}

	/** Hold B: flash the before state. */
	flash(on: boolean) {
		if (!this.against) return;
		this.ws.viewer?.setBlend(on ? 0 : this.blend);
	}

	close() {
		this.against = null;
		this.ws.viewer?.clearGhosts();
		this.ws.viewer?.setBlend(0.5);
	}

	// ---------- History: view a version read-only ----------
	async view(id: string) {
		const ws = this.ws;
		if (!ws.viewer || !ws.engine) return;
		this.close();
		this.viewing = id;
		this.loading = true;
		try {
			const v = await this.fetchVersion(id);
			this.viewScripts = v.scripts;
			const res = await this.regenerate(id, Object.keys(v.scripts).filter((p) => /^parts\/[^/]+\.ts$/.test(p)).map((p) => p.slice(6, -3)));
			const dark = document.documentElement.dataset.theme === 'dark';
			for (const part of ws.parts) if (!res.has(part)) ws.viewer.removePart(part);
			for (const [part, r] of res) ws.viewer.setPart({ id: part, mesh: r.mesh!, faceEdges: r.faceEdges, hiddenEdges: new Set(r.edges.flatMap((e, i) => (e.seam ? [i] : []))), color: ws.partColor(part, dark) });
		} catch (e) {
			this.error = (e as Error).message;
		} finally {
			this.loading = false;
		}
	}

	async back() {
		this.viewing = null;
		this.viewScripts = null;
		await this.ws.refreshAll();
	}

	/** Restore copies the version to the tip as a new version (§8 Versions). */
	async restore(id: string) {
		const ws = this.ws;
		await ws.zero.mutate(mutators.version.restore({ documentID: ws.documentID, versionID: id, newVersionID: newID() })).client;
		await this.back();
	}
}
