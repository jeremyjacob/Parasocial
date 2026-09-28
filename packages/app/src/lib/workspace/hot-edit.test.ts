import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParasocialZero, Script } from '@parasocial/sync';
import type { Viewer } from '@parasocial/viewer';
import type { EngineClient } from '@parasocial/runtime/browser/client';
import type { AssemblyInfo, PartInfo, PartResult } from '@parasocial/runtime/protocol';
import { WorkspaceState } from './state.svelte';

const info = (id: string): PartInfo => ({ id, file: `studios/${id}.ts`, export: 'default', name: id, studio: id });
const result = (part: string, key = part): PartResult => ({
	part, key, file: `studios/${part}.ts`, name: part, ok: true, partial: false, empty: false,
	problems: [], params: [], quality: 'fine', faces: [], edges: [], vertices: [], faceEdges: [],
	timings: { total: 0, script: 0, ops: 0, mesh: 0, cacheHits: 0, cacheMisses: 0 },
	mesh: { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(), faceRanges: new Uint32Array(), edgePositions: new Float32Array(), edgeRanges: new Uint32Array() }
});
const deferred = <T>() => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
};

describe('hot edits', () => {
	let ws: WorkspaceState;
	let infos: PartInfo[];
	let assembly: AssemblyInfo;
	let visible: Set<string>;
	const regenerate = vi.fn<EngineClient['regenerate']>();
	const removePart = vi.fn();
	const setPart = vi.fn();

	beforeEach(async () => {
		vi.resetAllMocks();
		localStorage.clear();
		infos = ['body', 'lid'].map(info);
		assembly = {
			id: 'mechanism', file: 'studios/mechanism.ts', export: 'default', name: 'Assembly', studio: 'Assembly',
			instances: [
				{ id: 'mechanism/body', part: 'body', scope: 'mechanism' },
				{ id: 'mechanism/lid', part: 'lid', scope: 'mechanism' },
				{ id: 'mechanism/lid@copy', part: 'lid', scope: 'mechanism', name: 'copy' }
			], subs: [], fixed: [], joints: [], problems: []
		};
		ws = new WorkspaceState({ documentID: 'doc', userID: 'user', zero: {} as ParasocialZero });
		ws.scripts = ['body', 'lid', 'mechanism'].map((id) => ({ path: `studios/${id}.ts`, content: id } as Script));
		ws.activeStudio = assembly.file;
		ws.synced = true;
		visible = new Set();
		removePart.mockImplementation((id: string) => visible.delete(id));
		setPart.mockImplementation(({ id }: { id: string }) => visible.add(id));
		ws.viewer = {
			partIds: () => [...visible], removePart, setPart, setVisible: vi.fn(), setPartErrors: vi.fn(),
			getSelection: () => ws.selection
		} as unknown as Viewer;
		vi.spyOn(ws.asm, 'check').mockImplementation(() => {});
		vi.spyOn(ws.asm, 'rebuild').mockImplementation(() => {});
		regenerate.mockImplementation(async (part) => result(part));
		ws.engine = {
			setDocument: vi.fn(async () => infos), setScript: vi.fn(async () => infos),
			assemblies: vi.fn(async () => [assembly]), affected: vi.fn(async () => ['body']),
			setOverrides: vi.fn(), regenerate
		} as unknown as EngineClient;
		await ws.sync();
		await vi.waitFor(() => expect(visible.size).toBe(3));
		vi.clearAllMocks();
	});

	it('keeps every assembly copy mounted through a partial script edit and no-op sync', async () => {
		const pending = deferred<PartResult>();
		regenerate.mockReturnValueOnce(pending.promise);
		const lid = ws.results['mechanism/lid'];
		const mesh = ws.meshOf('mechanism/lid');
		ws.hidden = ['mechanism/lid@copy'];
		ws.selection = [{ part: 'mechanism/lid', kind: 'face', index: 0 }];
		ws.scripts = ws.scripts.map((s) => s.path === 'studios/body.ts' ? { ...s, content: 'edited' } : s);
		await ws.sync();
		expect([...visible]).toEqual(assembly.instances.map((i) => i.id));
		expect(removePart).not.toHaveBeenCalled();
		pending.resolve(result('body', 'edited'));
		await vi.waitFor(() => expect(ws.regen.body).toBe('idle'));
		await ws.sync();
		expect(regenerate).toHaveBeenCalledTimes(1);
		expect(setPart).toHaveBeenCalledTimes(1);
		expect(ws.results['mechanism/lid']).toBe(lid);
		expect(ws.meshOf('mechanism/lid')).toBe(mesh);
		expect(ws.selection).toEqual([{ part: 'mechanism/lid', kind: 'face', index: 0 }]);
		expect(ws.hidden).toEqual(['mechanism/lid@copy']);
		expect(removePart).not.toHaveBeenCalled();
	});

	it('keeps copies for unchanged geometry when a parameter regenerates one part', async () => {
		regenerate.mockImplementationOnce(async (part) => ({ ...result(part), mesh: undefined, unchanged: true }));
		ws.live = { body: { width: 20 } };
		await ws.sync();
		await vi.waitFor(() => expect(ws.regen.body).toBe('idle'));
		expect([...visible]).toEqual(assembly.instances.map((i) => i.id));
		expect(removePart).not.toHaveBeenCalled();
		expect(setPart).not.toHaveBeenCalled();
	});

	it('still removes deleted source parts and their copies', async () => {
		infos = infos.filter((p) => p.id !== 'lid');
		assembly = { ...assembly, instances: assembly.instances.filter((i) => i.part !== 'lid') };
		ws.scripts = ws.scripts.filter((s) => s.path !== 'studios/lid.ts');
		await ws.sync();
		expect([...visible]).toEqual(['mechanism/body']);
		expect(ws.results.lid).toBeUndefined();
		expect(ws.results['mechanism/lid']).toBeUndefined();
		expect(ws.meshOf('lid')).toBeUndefined();
	});

	it('keeps updating until the newest regeneration finishes and ignores older results', async () => {
		const first = deferred<PartResult | null>();
		const second = deferred<PartResult | null>();
		regenerate.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		ws.live = { body: { width: 20 } };
		await ws.sync();
		ws.live = { body: { width: 30 } };
		await ws.sync();
		first.resolve(result('body', 'older'));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(ws.regen.body).toBe('running');
		expect(ws.results.body.key).toBe('body');
		second.resolve(result('body', 'newest'));
		await vi.waitFor(() => expect(ws.regen.body).toBe('idle'));
		expect(ws.results.body.key).toBe('newest');
	});

	it('does not roll back a newer result when an older request completes late', async () => {
		const older = deferred<PartResult | null>();
		regenerate.mockReturnValueOnce(older.promise).mockResolvedValueOnce(result('body', 'newest'));
		ws.live = { body: { width: 20 } };
		await ws.sync();
		ws.live = { body: { width: 30 } };
		await ws.sync();
		await vi.waitFor(() => expect(ws.results.body.key).toBe('newest'));
		older.resolve(result('body', 'older'));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(ws.results.body.key).toBe('newest');
		expect(ws.regen.body).toBe('idle');
	});

	it('does not resurrect a deleted part when its regeneration finishes', async () => {
		const pending = deferred<PartResult | null>();
		regenerate.mockReturnValueOnce(pending.promise);
		ws.live = { lid: { width: 20 } };
		await ws.sync();
		infos = infos.filter((p) => p.id !== 'lid');
		assembly = { ...assembly, instances: assembly.instances.filter((i) => i.part !== 'lid') };
		ws.scripts = ws.scripts.filter((s) => s.path !== 'studios/lid.ts');
		await ws.sync();
		pending.resolve(result('lid', 'late'));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(ws.results.lid).toBeUndefined();
		expect(ws.meshOf('lid')).toBeUndefined();
		expect(ws.regen.lid).toBeUndefined();
		expect([...visible]).toEqual(['mechanism/body']);
	});
});
