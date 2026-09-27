import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mutators, type ParasocialZero } from '@parasocial/sync';
import type { Viewer } from '@parasocial/viewer';
import { WorkspaceState } from './state.svelte';

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
