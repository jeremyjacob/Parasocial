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

function setup() {
	localStorage.clear();
	const ws = new WorkspaceState({ documentID: 'doc', userID: 'user', zero: {} as ParasocialZero });
	vi.spyOn(ws, 'publishPresence').mockImplementation(() => {});
	vi.spyOn(ws, 'partTree', 'get').mockReturnValue([
		{ file: 'studios/model.ts', name: 'Model', parts: [], assemblies: [], instances: [], ids: ['base', 'lid', 'handle'] }
	]);
	const onExport = vi.fn();
	const onAddNote = vi.fn();
	const onAddStudioNote = vi.fn();
	const ui = render(Harness, { props: { component: PartsPanel, props: { ws, onExport, onAddStudio: vi.fn(), onAddNote, onAddStudioNote } } });
	return { ws, onExport, onAddNote, onAddStudioNote, ...ui };
}

describe('parts context-menu export', () => {
	it('exports every selected part when right-clicking a selected row', async () => {
		const { ws, onExport, getByText, getByRole } = setup();
		await fireEvent.click(getByText('base'));
		await fireEvent.click(getByText('lid'), { shiftKey: true });
		const selection = [...ws.selection];
		await fireEvent.contextMenu(getByText('base'), { button: 2 });
		await fireEvent.click(getByRole('menuitem', { name: 'Export…' }));
		expect(onExport).toHaveBeenCalledExactlyOnceWith(['base', 'lid']);
		expect(ws.selection).toEqual(selection);
	});

	it('exports only the right-clicked part when it is outside the selection', async () => {
		const { onExport, getByText, getByRole } = setup();
		await fireEvent.click(getByText('base'));
		await fireEvent.click(getByText('lid'), { shiftKey: true });
		await fireEvent.contextMenu(getByText('handle'), { button: 2 });
		await fireEvent.click(getByRole('menuitem', { name: 'Export…' }));
		expect(onExport).toHaveBeenCalledExactlyOnceWith(['handle']);
	});

	it('exports the studio when opening its context menu', async () => {
		const { onExport, getByText, getByRole } = setup();
		await fireEvent.click(getByText('base'));
		await fireEvent.contextMenu(getByText('Model'), { button: 2 });
		await fireEvent.click(getByRole('menuitem', { name: 'Export…' }));
		expect(onExport).toHaveBeenCalledExactlyOnceWith(['base', 'lid', 'handle']);
	});
});

it('adds one studio target from the studio menu instead of expanding its parts', async () => {
	const { onAddNote, onAddStudioNote, getByText, getByRole } = setup();
	await fireEvent.contextMenu(getByText('Model'), { button: 2 });
	await fireEvent.click(getByRole('menuitem', { name: 'Add note' }));
	expect(onAddStudioNote).toHaveBeenCalledExactlyOnceWith('studios/model.ts');
	expect(onAddNote).not.toHaveBeenCalled();
});
