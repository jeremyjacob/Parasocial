import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import type { ParasocialZero } from '@parasocial/sync';
import Harness from '$lib/test/harness.svelte';
import PartsPanel from './PartsPanel.svelte';
import { WorkspaceState } from './state.svelte';

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

async function setup(ids = ['base', 'lid', 'handle']) {
	localStorage.clear();
	const ws = new WorkspaceState({ documentID: 'doc', userID: 'user', zero: {} as ParasocialZero });
	vi.spyOn(ws, 'publishPresence').mockImplementation(() => {});
	vi.spyOn(ws, 'partTree', 'get').mockReturnValue([
		{ file: 'studios/model.ts', name: 'Model', parts: [], assemblies: [], instances: [], ids }
	]);
	const onExport = vi.fn();
	const onAddNote = vi.fn();
	const onAddStudioNote = vi.fn();
	const ui = render(Harness, { props: { component: PartsPanel, props: { ws, onExport, onAddStudio: vi.fn(), onAddNote, onAddStudioNote } } });
	// studios start collapsed
	await fireEvent.click(ui.getByRole('button', { name: 'Expand Model' }));
	return { ws, onExport, onAddNote, onAddStudioNote, ...ui };
}

describe('parts context-menu export', () => {
	it('exports every selected part when right-clicking a selected row', async () => {
		const { ws, onExport, getByText, getByRole } = await setup();
		await fireEvent.click(getByText('base'));
		await fireEvent.click(getByText('lid'), { shiftKey: true });
		const selection = [...ws.selection];
		await fireEvent.contextMenu(getByText('base'), { button: 2 });
		await fireEvent.click(getByRole('menuitem', { name: 'Export…' }));
		expect(onExport).toHaveBeenCalledExactlyOnceWith(['base', 'lid']);
		expect(ws.selection).toEqual(selection);
	});

	it('exports only the right-clicked part when it is outside the selection', async () => {
		const { onExport, getByText, getByRole } = await setup();
		await fireEvent.click(getByText('base'));
		await fireEvent.click(getByText('lid'), { shiftKey: true });
		await fireEvent.contextMenu(getByText('handle'), { button: 2 });
		await fireEvent.click(getByRole('menuitem', { name: 'Export…' }));
		expect(onExport).toHaveBeenCalledExactlyOnceWith(['handle']);
	});

	it('exports the studio when opening its context menu', async () => {
		const { onExport, getByText, getByRole } = await setup();
		await fireEvent.click(getByText('base'));
		await fireEvent.contextMenu(getByText('Model'), { button: 2 });
		await fireEvent.click(getByRole('menuitem', { name: 'Export…' }));
		expect(onExport).toHaveBeenCalledExactlyOnceWith(['base', 'lid', 'handle']);
	});
});

it.each([{ label: 'exported parts', ids: ['base', 'lid', 'handle'] }, { label: 'no parts', ids: [] }])('adds one studio target from the studio menu with $label', async ({ ids }) => {
	const { onAddNote, onAddStudioNote, getByText, getByRole } = await setup(ids);
	await fireEvent.contextMenu(getByText('Model'), { button: 2 });
	await fireEvent.click(getByRole('menuitem', { name: 'Add note' }));
	expect(onAddStudioNote).toHaveBeenCalledExactlyOnceWith('studios/model.ts');
	expect(onAddNote).not.toHaveBeenCalled();
});

describe('shift span selection', () => {
	const parts = (ws: WorkspaceState) => ws.selection.map((s) => s.part);
	const ids = ['a', 'b', 'c', 'd', 'e'];

	it('selects the rows between the anchor and the shift-clicked row, either direction', async () => {
		const { ws, getByText } = await setup(ids);
		ws.additiveSelection = false;
		await fireEvent.pointerDown(getByText('b'));
		await fireEvent.pointerDown(getByText('d'), { shiftKey: true });
		expect(parts(ws)).toEqual(['b', 'c', 'd']);
		// the anchor stays on b: shift-clicking above it re-spans from there
		await fireEvent.pointerDown(getByText('a'), { shiftKey: true });
		expect(parts(ws)).toEqual(['a', 'b']);
	});

	it('adds the span to the selection with ⌘ held', async () => {
		const { ws, getByText } = await setup(ids);
		ws.additiveSelection = false;
		await fireEvent.pointerDown(getByText('a'));
		await fireEvent.pointerDown(getByText('c'), { metaKey: true });
		await fireEvent.pointerDown(getByText('e'), { metaKey: true, shiftKey: true });
		expect(parts(ws)).toEqual(['a', 'c', 'd', 'e']);
	});

	it('selects just the row when there is no anchor', async () => {
		const { ws, getByText } = await setup(ids);
		ws.additiveSelection = false;
		await fireEvent.pointerDown(getByText('c'), { shiftKey: true });
		expect(parts(ws)).toEqual(['c']);
	});
});

it('expands and scrolls to a part selected elsewhere', async () => {
	const { ws, getByText, getByRole, queryByText } = await setup();
	await fireEvent.click(getByRole('button', { name: 'Collapse Model' }));
	expect(queryByText('lid')).toBeNull();
	const scroll = vi.fn();
	Element.prototype.scrollIntoView = scroll;
	ws.select([{ part: 'lid', kind: 'face' as any, index: 3 }]);
	await vi.waitFor(() => expect(scroll).toHaveBeenCalled());
	expect(scroll.mock.contexts[0]).toBe(getByText('lid').closest('[data-part]'));
});
