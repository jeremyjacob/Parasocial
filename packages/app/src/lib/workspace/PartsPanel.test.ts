import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import type { ParasocialZero } from '@parasocial/sync';
import Harness from '$lib/test/harness.svelte';
import PartsPanel from './PartsPanel.svelte';
import { WorkspaceState } from './state.svelte';
import { nestedAssemblies } from '$lib/test/assemblies';

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

async function setupAssembly() {
	localStorage.clear();
	const ws = new WorkspaceState({ documentID: 'doc', userID: 'user', zero: {} as ParasocialZero });
	vi.spyOn(ws, 'publishPresence').mockImplementation(() => {});
	vi.spyOn(ws.asm, 'check').mockImplementation(() => {});
	ws.asm.assemblies = nestedAssemblies();
	ws.partInfos = ['base', 'lid'].map((p) => ({ id: `parts:${p}`, name: p === 'base' ? 'Base' : 'Lid', studio: 'Parts', file: 'studios/parts.ts', export: p }));
	const rack = ws.asm.assemblies[0];
	vi.spyOn(ws, 'partTree', 'get').mockReturnValue([{ file: rack.file, name: rack.name, parts: [], assemblies: [rack], instances: rack.instances, ids: rack.instances.map((i) => i.id) }]);
	const onExport = vi.fn();
	const onAddNote = vi.fn();
	const ui = render(Harness, { props: { component: PartsPanel, props: { ws, onExport, onAddNote, onAddStudio: vi.fn(), onAddStudioNote: vi.fn() } } });
	await fireEvent.click(ui.getByRole('button', { name: 'Expand Rack' }));
	return { ws, onExport, onAddNote, ...ui };
}

describe('subassembly tree', () => {
	it('keeps multiple assembly exports in separate groups', async () => {
		const { ws, container, getByRole } = await setupAssembly();
		const [rack, module] = ws.asm.assemblies;
		vi.spyOn(ws, 'partTree', 'get').mockReturnValue([{ file: rack.file, name: 'Mechanisms', parts: [], assemblies: [rack, module], instances: rack.instances, ids: rack.instances.map((i) => i.id) }]);
		// Changing the tree's metadata is reactive when the engine's discovery changes.
		ws.asm.assemblies = [...ws.asm.assemblies];
		await vi.waitFor(() => expect(container.querySelectorAll('[data-assembly]')).toHaveLength(2));
		expect(container.querySelectorAll('[data-subassembly]')).toHaveLength(0);
		await fireEvent.click(getByRole('button', { name: 'Expand Rack' }));
		expect(container.querySelector('[data-subassembly="rack/module@left"]')).toBeTruthy();
	});

	it('retains source part rows when the engine reports mixed exports', async () => {
		const { ws, getByText } = await setupAssembly();
		const rack = { ...ws.asm.assemblies[0], instances: [], subs: [], joints: [] };
		ws.asm.assemblies = [rack];
		vi.spyOn(ws, 'partTree', 'get').mockReturnValue([{ file: rack.file, name: rack.name, parts: ws.partInfos.slice(0, 1), assemblies: [rack], instances: [], ids: ['parts:base'] }]);
		await vi.waitFor(() => expect(getByText('Base')).toBeTruthy());
	});

	it('offers code access but no geometry actions for an empty subassembly', async () => {
		const { ws, getByRole, getByText, queryByRole } = await setupAssembly();
		const rack = { ...ws.asm.assemblies[0], subs: [...ws.asm.assemblies[0].subs, { id: 'rack/module@empty', parent: 'rack', assembly: 'module', name: 'empty' }] };
		ws.asm.assemblies = [rack, ...ws.asm.assemblies.slice(1)];
		vi.spyOn(ws, 'partTree', 'get').mockReturnValue([{ file: rack.file, name: rack.name, parts: [], assemblies: [rack], instances: rack.instances, ids: rack.instances.map((i) => i.id) }]);
		await vi.waitFor(() => expect(getByText('Module empty')).toBeTruthy());
		await fireEvent.contextMenu(getByText('Module empty'), { button: 2 });
		expect(getByRole('menuitem', { name: 'Open assembly code' })).toBeTruthy();
		expect(queryByRole('menuitem', { name: 'Export…' })).toBeNull();
		expect(queryByRole('menuitem', { name: 'Add note' })).toBeNull();
	});

	it('selects a whole nested copy and exports or notes that group', async () => {
		const { ws, onExport, onAddNote, getByRole, getByText, queryByRole } = await setupAssembly();
		expect(queryByRole('button', { name: 'Expand Hinge door' })).toBeNull();
		await fireEvent.click(getByText('Module left'));
		expect(ws.selection.map((s) => s.part)).toEqual(ws.asm.assemblies[0].instances.slice(1, 4).map((i) => i.id));
		expect(ws.selectedAssemblyScope?.id).toBe('rack/module@left');
		await fireEvent.contextMenu(getByText('Module left'), { button: 2 });
		await fireEvent.click(getByRole('menuitem', { name: 'Export…' }));
		expect(onExport).toHaveBeenCalledExactlyOnceWith(ws.selection.map((s) => s.part));
		await fireEvent.contextMenu(getByText('Module left'), { button: 2 });
		await fireEvent.click(getByRole('menuitem', { name: 'Add note' }));
		expect(onAddNote).toHaveBeenCalledExactlyOnceWith(ws.selection.map((s) => s.part));
	});

	it('hides all descendants in one undo action and restores mixed visibility', async () => {
		const { ws, getByRole } = await setupAssembly();
		const ids = ws.asm.assemblies[0].instances.slice(1, 4).map((i) => i.id);
		ws.hidden = [ids[0]];
		await fireEvent.click(getByRole('button', { name: 'Hide Module left' }));
		expect(new Set(ws.hidden)).toEqual(new Set(ids));
		expect(ws.undoStack).toHaveLength(1);
		await ws.undo();
		expect(ws.hidden).toEqual([ids[0]]);
		await ws.redo();
		expect(new Set(ws.hidden)).toEqual(new Set(ids));
	});

	it('reveals every ancestor of a viewport-selected part with a local part label', async () => {
		const { ws, container, getByRole } = await setupAssembly();
		const id = 'rack/module@left/hinge@door/parts:lid';
		Element.prototype.scrollIntoView = vi.fn();
		ws.select([{ part: id, kind: 'face' as any, index: 0 }]);
		await vi.waitFor(() => expect(container.querySelector(`[data-part="${id}"] .row-main`)?.textContent).toBe('Lid'));
		expect(getByRole('button', { name: 'Collapse Module left' })).toBeTruthy();
		expect(getByRole('button', { name: 'Collapse Hinge door' })).toBeTruthy();
	});

	it('keeps ancestors when filtering a descendant and shows a matching group with its children', async () => {
		const { container, getByRole, queryByText } = await setupAssembly();
		await fireEvent.input(getByRole('textbox', { name: 'Filter studios and parts' }), { target: { value: 'Lid' } });
		expect(container.querySelector('[data-subassembly="rack/module@left/hinge@door"]')).toBeTruthy();
		expect(queryByText('Base')).toBeNull();
		await fireEvent.input(getByRole('textbox', { name: 'Filter studios and parts' }), { target: { value: 'Hinge door' } });
		expect(container.querySelector('[data-part="rack/module@left/hinge@door/parts:base"]')).toBeTruthy();
		expect(queryByText('Module left2')).toBeNull();
	});
});
