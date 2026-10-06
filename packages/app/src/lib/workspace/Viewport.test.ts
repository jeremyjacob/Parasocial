import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { ParasocialZero } from '@parasocial/sync';
import type { EngineClient } from '@parasocial/runtime/browser/client';
import Harness from '$lib/test/harness.svelte';
import Viewport from './Viewport.svelte';
import { WorkspaceState, type PartMeta } from './state.svelte';
import { NotesController } from './notes.svelte';

const { events, setDimension } = vi.hoisted(() => ({ events: new Map<string, (() => void)[]>(), setDimension: vi.fn() }));
vi.mock('$app/environment', () => ({ dev: false }));
vi.mock('@parasocial/viewer', async (importOriginal) => ({
	...await importOriginal<typeof import('@parasocial/viewer')>(),
	Viewer: class {
		on(event: string, callback: () => void) { events.set(event, [...events.get(event) ?? [], callback]); return () => {}; }
		listenOn() { return () => {}; }
		setTheme() {}
		setDisplayMode() {}
		setProjection() {}
		setDimension = setDimension;
		setSectionArrowHover() {}
		setSection() {}
		setBuild() {}
		setHelpers() {}
		setOverlapsOnTop() {}
		setMarkup() {}
		setSelection() {}
		partTransform() { return null; }
		facePlane() { return null; }
		dispose() {}
	}
}));

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	events.clear();
	setDimension.mockClear();
});

const distance = (value: number) => ({ distance: value, a: [0, 0, 0], b: [value, 0, 0] });

function setup() {
	localStorage.clear();
	const ws = new WorkspaceState({ documentID: 'doc', userID: 'user', zero: {} as ParasocialZero });
	for (const method of ['showStudio', 'retheme', 'refreshThumbnail', 'detachViewer'] as const) vi.spyOn(ws, method).mockImplementation(() => {});
	vi.spyOn(ws, 'sync').mockResolvedValue();
	vi.spyOn(ws, 'attachViewer').mockImplementation((viewer) => { ws.viewer = viewer; return true; });
	const measure = vi.fn().mockResolvedValue(distance(10));
	ws.engine = { measure } as unknown as EngineClient;
	ws.kernelReady = true;
	ws.results = { shaft: { key: 'shape-1', faces: [], edges: [], problems: [] } as unknown as PartMeta };
	ws.selection = [{ part: 'shaft', kind: 'face', index: 0 }, { part: 'shaft', kind: 'face', index: 1 }];
	return { ws, measure, mount: () => render(Harness, { props: {
		component: Viewport, props: { ws, nc: new NotesController(ws), onAddStudio: vi.fn(), onConnect: vi.fn(), onOpenNote: vi.fn() }
	} }) };
}

describe('pair measurements', () => {
	it('shows loading for cached geometry, then measures without reselecting the faces', async () => {
		const { ws, measure, mount } = setup();
		ws.results.shaft = { ...ws.results.shaft, fromCache: true };
		ws.regen = { shaft: 'running' };
		const ui = mount();
		await waitFor(() => expect(ui.getByTestId('measure-card').textContent).toContain('Loading geometry…'));
		expect(measure).not.toHaveBeenCalled();
		ws.results = { shaft: { ...ws.results.shaft, fromCache: false } };
		ws.regen = { shaft: 'idle' };
		await waitFor(() => expect(ui.getByTestId('measure-card').textContent).toContain('Minimum distance'));
		expect(measure).toHaveBeenCalledExactlyOnceWith(...ws.selection);
		expect(ui.getByTestId('measure-card').textContent).toContain('10');
	});

	it('shows a failed measurement and lets the user retry it', async () => {
		const { measure, mount } = setup();
		measure.mockRejectedValueOnce(new Error('distance computation failed'));
		const ui = mount();
		await waitFor(() => expect(ui.getByRole('alert').textContent).toContain('distance computation failed'));
		await fireEvent.click(ui.getByRole('button', { name: 'Retry' }));
		await waitFor(() => expect(ui.getByTestId('measure-card').textContent).toContain('Minimum distance'));
		expect(ui.queryByRole('alert')).toBeNull();
		expect(measure).toHaveBeenCalledTimes(2);
	});

	it('retries when the selected geometry changes, but ignores unrelated geometry updates', async () => {
		const { ws, measure, mount } = setup();
		measure.mockRejectedValueOnce(new Error('shape is not ready'));
		const ui = mount();
		await waitFor(() => expect(ui.getByRole('alert').textContent).toContain('shape is not ready'));
		ws.results = { ...ws.results, other: { key: 'unrelated' } as PartMeta };
		await tick();
		expect(measure).toHaveBeenCalledTimes(1);
		ws.results = { ...ws.results, shaft: { ...ws.results.shaft, key: 'shape-2' } };
		await waitFor(() => expect(ui.getByTestId('measure-card').textContent).toContain('Minimum distance'));
		expect(measure).toHaveBeenCalledTimes(2);
	});

	it('ignores an old response after the same selection moves to a new pose', async () => {
		const { measure, mount } = setup();
		let finish!: (result: ReturnType<typeof distance>) => void;
		measure.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
		measure.mockResolvedValueOnce(distance(20));
		const ui = mount();
		await waitFor(() => expect(measure).toHaveBeenCalledTimes(1));
		events.get('poses')!.forEach((callback) => callback());
		await waitFor(() => expect(ui.getByTestId('measure-card').textContent).toContain('20'));
		finish(distance(999));
		await tick();
		expect(ui.getByTestId('measure-card').textContent).not.toContain('999');
		expect(setDimension.mock.lastCall?.[1].x).toBe(20);
	});
});

describe('status pill', () => {
	it('shows a studio showing an assembly twice as a warning, below assembly errors', async () => {
		const { ws, mount } = setup();
		ws.selection = [];
		const warning = { assembly: 'rig:corner', severity: 'warning' as const, message: 'studio "Rig" shows "Corner" twice: exported and inserted by "Cart"', source: { file: 'studios/rig.ts', line: 5 } };
		ws.asm.problems = [warning];
		const ui = mount();
		await waitFor(() => expect(ui.getByText('rig:corner: 1 warning')).toBeTruthy());
		expect(ui.queryByText(/joints need a fix/)).toBeNull();
		ws.asm.problems = [warning, { assembly: 'rig', message: 'no connector "hub"' }];
		await waitFor(() => expect(ui.getByText('rig: joints need a fix')).toBeTruthy());
	});
});
