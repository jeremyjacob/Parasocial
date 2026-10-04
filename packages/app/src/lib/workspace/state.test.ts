import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mutators, type ParasocialZero } from '@parasocial/sync';
import type { Viewer } from '@parasocial/viewer';
import { WorkspaceState } from './state.svelte';
import { nestedAssemblies } from '$lib/test/assemblies';

describe('visibility undo', () => {
	let ws: WorkspaceState;
	const setVisible = vi.fn();
	const run = vi.fn();
	const mutate = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
		ws = new WorkspaceState({ documentID: 'doc', userID: 'user', zero: { run, mutate } as unknown as ParasocialZero });
		ws.viewer = { setVisible } as unknown as Viewer;
		vi.spyOn(ws.asm, 'check').mockImplementation(() => {});
	});

	it('undoes and redoes hiding and showing a part without syncing view state', async () => {
		ws.setHidden('base', true);
		expect(ws.hidden).toEqual(['base']);
		expect(await ws.undo()).toBe('Hide base');
		expect(ws.hidden).toEqual([]);
		expect(setVisible).toHaveBeenLastCalledWith('base', true);
		expect(await ws.redo()).toBe('Hide base');
		expect(ws.hidden).toEqual(['base']);
		expect(setVisible).toHaveBeenLastCalledWith('base', false);
		ws.setHidden('base', false);
		expect(await ws.undo()).toBe('Show base');
		expect(ws.hidden).toEqual(['base']);
		await ws.redo();
		expect(ws.hidden).toEqual([]);
		expect(ws.asm.check).toHaveBeenCalledTimes(6);
		expect(run).not.toHaveBeenCalled();
		expect(mutate).not.toHaveBeenCalled();
	});

	it('restores mixed visibility in one step, including instances and duplicate targets', async () => {
		ws.hidden = ['base', 'other'];
		ws.setVisibility([{ part: 'base', hidden: false }, { part: 'assembly/lid', hidden: true }, { part: 'base', hidden: false }]);
		expect(ws.undoStack).toHaveLength(1);
		expect(ws.hidden).toEqual(['other', 'assembly/lid']);
		await ws.undo();
		expect(new Set(ws.hidden)).toEqual(new Set(['base', 'other']));
		await ws.redo();
		expect(ws.hidden).toEqual(['other', 'assembly/lid']);
		ws.setVisibility(ws.hidden.map((part) => ({ part, hidden: false })));
		expect(ws.hidden).toEqual([]);
		await ws.undo();
		expect(ws.hidden).toEqual(['other', 'assembly/lid']);
	});

	it('ignores no-ops, clears redo on new changes, and caps history', async () => {
		ws.setHidden('base', true);
		await ws.undo();
		ws.setHidden('base', false);
		ws.setVisibility([]);
		expect(ws.undoStack).toHaveLength(0);
		expect(ws.redoStack).toHaveLength(1);
		ws.setHidden('lid', true);
		expect(ws.redoStack).toHaveLength(0);
		for (let i = 0; i < 110; i++) ws.setHidden(`part-${i}`, true);
		expect(ws.undoStack).toHaveLength(100);
	});

	it('shares chronological undo and redo with synced mutations', async () => {
		let name = 'Original';
		run.mockImplementation(async () => ({ name }));
		mutate.mockImplementation((mr) => { name = mr.args.name; });
		ws.setHidden('base', true);
		await ws.mutate(mutators.configuration.rename({ id: 'config', name: 'Renamed' }), 'Rename configuration');
		ws.setHidden('lid', true);
		expect(await ws.undo()).toBe('Hide lid');
		expect(name).toBe('Renamed');
		expect(await ws.undo()).toBe('Rename configuration');
		expect(name).toBe('Original');
		expect(await ws.undo()).toBe('Hide base');
		expect(ws.hidden).toEqual([]);
		await ws.redo();
		await ws.redo();
		await ws.redo();
		expect(name).toBe('Renamed');
		expect(ws.hidden).toEqual(['base', 'lid']);
	});
});

describe('isolate', () => {
	let ws: WorkspaceState;
	const shown = new Map<string, boolean>();

	beforeEach(() => {
		localStorage.clear();
		shown.clear();
		ws = new WorkspaceState({ documentID: 'doc', userID: 'user', zero: { run: vi.fn(), mutate: vi.fn() } as unknown as ParasocialZero });
		ws.viewer = { setVisible: (id: string, v: boolean) => shown.set(id, v), setSelection: vi.fn() } as unknown as Viewer;
		vi.spyOn(ws, 'publishPresence').mockImplementation(() => {});
		vi.spyOn(ws.asm, 'check').mockImplementation(() => {});
		vi.spyOn(ws, 'partTree', 'get').mockReturnValue([{ file: 'studios/model.ts', name: 'Model', parts: [], assemblies: [], instances: [], ids: ['base', 'lid', 'handle', 'knob'] }] as any);
	});
	const part = (p: string) => ({ part: p, kind: 'part' as any, index: 0 });

	it('shows only the selection and restores the visibility from before, hidden parts included', () => {
		ws.setHidden('knob', true);
		ws.select([part('base'), { part: 'base', kind: 'face', index: 2 }, part('lid')]);
		expect(ws.toggleIsolate()).toBe(true);
		expect(ws.isolated).toEqual(['base', 'lid']);
		expect(Object.fromEntries(shown)).toEqual({ base: true, lid: true, handle: false, knob: false });
		expect(ws.hidden).toEqual(['knob']);
		expect(ws.undoStack).toHaveLength(1);
		expect(ws.toggleIsolate()).toBe(true);
		expect(ws.isolated).toBeNull();
		expect(Object.fromEntries(shown)).toEqual({ base: true, lid: true, handle: true, knob: false });
	});

	it('does nothing without a selection, and isolating a hidden part shows it until exit', () => {
		expect(ws.toggleIsolate()).toBe(false);
		expect(ws.isolated).toBeNull();
		ws.setHidden('knob', true);
		ws.select([part('knob')]);
		ws.toggleIsolate();
		expect(ws.isShown('knob')).toBe(true);
		ws.exitIsolate();
		expect(ws.isShown('knob')).toBe(false);
		expect(shown.get('knob')).toBe(false);
	});

	it('hiding and showing while isolated change the isolation, not the visibility restored on exit', () => {
		ws.setHidden('knob', true);
		ws.isolate(['base', 'lid']);
		ws.setVisibility([{ part: 'lid', hidden: true }, { part: 'handle', hidden: false }]);
		expect(new Set(ws.isolated)).toEqual(new Set(['base', 'handle']));
		expect(shown.get('lid')).toBe(false);
		expect(shown.get('handle')).toBe(true);
		expect(ws.undoStack).toHaveLength(1);
		ws.exitIsolate();
		expect(ws.hidden).toEqual(['knob']);
		expect(Object.fromEntries(shown)).toEqual({ base: true, lid: true, handle: true, knob: false });
	});

	it('leaves isolation when switching studios', () => {
		vi.spyOn(ws, 'partTree', 'get').mockReturnValue([
			{ file: 'studios/a.ts', name: 'A', parts: [], assemblies: [], instances: [], ids: ['base'] },
			{ file: 'studios/b.ts', name: 'B', parts: [], assemblies: [], instances: [], ids: ['other'] }
		] as any);
		ws.viewer = { setVisible: (id: string, v: boolean) => shown.set(id, v), setSelection: vi.fn(), partIds: () => [], removePart: vi.fn() } as unknown as Viewer;
		ws.isolate(['base', 'other']);
		expect(ws.isolated).toEqual(['base']);
		ws.setActiveStudio('studios/b.ts');
		expect(ws.isolated).toBeNull();
	});
});

it('toggles subassemblies as whole groups and drops scope properties for a part selection', () => {
	localStorage.clear();
	const ws = new WorkspaceState({ documentID: 'doc', userID: 'user', zero: {} as ParasocialZero });
	vi.spyOn(ws, 'publishPresence').mockImplementation(() => {});
	ws.asm.assemblies = nestedAssemblies();
	const scope = 'rack/module@left';
	ws.select([{ part: 'rack/module@left/parts:base', kind: 'part' as any, index: 0 }]);
	ws.selectAssemblyScope(scope, 'toggle');
	expect(ws.selection).toHaveLength(3);
	expect(ws.selectedAssemblyScope?.id).toBe(scope);
	ws.selectAssemblyScope(scope, 'toggle');
	expect(ws.selection).toEqual([]);
	expect(ws.selectedAssemblyScope).toBeNull();
	ws.selectAssemblyScope(scope);
	ws.select([{ part: 'rack/module@left/parts:base', kind: 'face', index: 0 }]);
	expect(ws.selectedAssemblyScope).toBeNull();
	ws.selectAssemblyScope(scope);
	ws.asm.assemblies = [];
	expect(ws.selectedAssemblyScope).toBeNull();
});
