import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { Box3, Vector3 } from 'three';
import type { Note, ParasocialZero, Script } from '@parasocial/sync';
import type { Viewer } from '@parasocial/viewer';
import type { PartResult } from '@parasocial/runtime/protocol';
import Harness from '$lib/test/harness.svelte';
import NoteComposer from './NoteComposer.svelte';
import { NotesController } from './notes.svelte';
import { WorkspaceState } from './state.svelte';

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const file = 'studios/model.ts';
const camera = { position: [10, 10, 10], target: [0, 0, 0], up: [0, 0, 1], fov: 45, ortho: false };
function setup() {
	localStorage.clear();
	const mutate = vi.fn();
	const ws = new WorkspaceState({ documentID: 'doc', userID: 'user', zero: { mutate } as unknown as ParasocialZero });
	ws.scripts = [{ path: file }] as Script[];
	vi.spyOn(ws, 'setActiveStudio').mockImplementation(() => {});
	const tree = vi.spyOn(ws, 'partTree', 'get').mockReturnValue([
		{ file, name: 'Model', parts: [], assemblies: [], instances: [], ids: ['rear', 'front'] }
	]);
	ws.viewer = {
		bounds: () => new Box3(new Vector3(0, 0, 0), new Vector3(10, 20, 30)),
		project: () => ({ x: 100, y: 200 }), cameraState: () => camera,
		snapshot: vi.fn(async () => new Blob(['image'], { type: 'image/webp' })), getSection: () => null
	} as unknown as Viewer;
	const nc = new NotesController(ws);
	const note = {
		id: 'note', createdAt: 1, status: 'Open', orphaned: false, authorUserID: 'user',
		anchor: { targets: [{ kind: 'studio', studio: file, name: 'Model', point: [5, 10, 15] }], camera, snapshot: 'a'.repeat(64), version: '', configuration: 'Default' }
	} as Note;
	ws.notes = [note];
	return { ws, nc, note, mutate, tree };
}

describe('studio notes', () => {
	it('composes and saves one studio target without the geometry engine', async () => {
		const { ws, nc, note } = setup();
		const mutate = vi.spyOn(ws, 'mutate').mockResolvedValue({ client: Promise.resolve({ type: 'success' }) } as any);
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ hash: 'a'.repeat(64) }))));
		nc.startFromStudio(file);
		const ui = render(Harness, { props: { component: NoteComposer, props: { ws, nc } } });
		expect(ui.getByText('Studio: Model')).toBeTruthy();
		expect(nc.draft?.targets).toEqual([{ ref: { kind: 'studio', studio: file }, point: [5, 10, 15] }]);
		expect(await nc.post('Simplify the housing')).toBe(true);
		expect((mutate.mock.calls[0][0].args as any).anchor.targets).toEqual(note.anchor.targets);
	});

	it('keeps the studio anchor while its exports change and highlights its current contents', async () => {
		const { ws, nc, note, tree } = setup();
		ws.results = { rear: { empty: false }, front: { empty: false } } as unknown as Record<string, PartResult>;
		expect((await nc.targetRefs(note)).map((r) => r.part)).toEqual(['rear', 'front']);
		tree.mockReturnValue([{ file, name: 'Renamed model', parts: [], assemblies: [], instances: [], ids: ['replacement/copy'] }]);
		ws.results = { 'replacement/copy': { empty: false } } as unknown as Record<string, PartResult>;
		await nc.resolveAll();
		expect(nc.pins[0]).toMatchObject({ studio: file, part: undefined, orphaned: false, point: [5, 10, 15], resolution: 'name' });
		expect((await nc.targetRefs(note)).map((r) => r.part)).toEqual(['replacement/copy']);
		ws.results = {};
		await nc.resolveAll();
		expect(nc.pins[0].orphaned).toBe(false);
	});

	it('marks a deleted studio orphaned and resolves it again when restored', async () => {
		const { ws, nc, note, mutate } = setup();
		ws.scripts = [];
		await nc.resolveAll();
		expect(nc.pins[0].orphaned).toBe(true);
		expect(mutate.mock.calls[0][0].args).toEqual({ noteID: note.id, orphaned: true });
		ws.notes = [{ ...note, orphaned: true }];
		ws.scripts = [{ path: file }] as Script[];
		await nc.resolveAll();
		expect(nc.pins[0].orphaned).toBe(false);
		expect(mutate.mock.calls[1][0].args).toEqual({ noteID: note.id, orphaned: false });
	});

	it('can start a studio note with no displayed geometry', () => {
		const { ws, nc } = setup();
		vi.spyOn(ws.viewer!, 'bounds').mockReturnValue(new Box3());
		nc.startFromStudio(file);
		expect(nc.draft?.targets[0].point).toEqual(camera.target);
	});

	it('labels multiple whole-part targets without undefined', () => {
		const { ws, nc } = setup();
		nc.startFromTargets(['rear', 'front'].map((part) => ({ ref: { part, kind: 'part', index: 0 }, point: [0, 0, 0] })), { x: 0, y: 0 });
		const ui = render(Harness, { props: { component: NoteComposer, props: { ws, nc } } });
		expect(ui.getByText('2 parts: rear, front')).toBeTruthy();
	});
});
