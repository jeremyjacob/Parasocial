import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import type { ParasocialZero } from '@parasocial/sync';
import Harness from '$lib/test/harness.svelte';
import { nestedAssemblies } from '$lib/test/assemblies';
import PropertiesPanel from './PropertiesPanel.svelte';
import { WorkspaceState } from './state.svelte';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('shows the selected subassembly and only its scoped joints, saving into the owning assembly', async () => {
	localStorage.clear();
	const ws = new WorkspaceState({ documentID: 'doc', userID: 'user', zero: {} as ParasocialZero });
	vi.spyOn(ws, 'publishPresence').mockImplementation(() => {});
	ws.asm.assemblies = nestedAssemblies();
	const rack = ws.asm.assemblies[0];
	vi.spyOn(ws, 'partTree', 'get').mockReturnValue([{ file: rack.file, name: rack.name, parts: [], assemblies: [rack], instances: rack.instances, ids: rack.instances.map((i) => i.id) }]);
	ws.selectAssemblyScope('rack/module@left');
	const commitJoint = vi.spyOn(ws.asm, 'commitJoint').mockResolvedValue(undefined);
	const { container, getByText, getByRole } = render(Harness, { props: { component: PropertiesPanel, props: { ws } } });
	expect(getByText('Module left')).toBeTruthy();
	expect(getByText('Subassembly')).toBeTruthy();
	expect(getByText('studios/module.ts')).toBeTruthy();
	expect(container.querySelectorAll('[data-joint]')).toHaveLength(1);
	const input = getByRole('spinbutton', { name: 'Open · Hinge door' });
	await fireEvent.focus(input);
	await fireEvent.input(input, { target: { value: '30' } });
	await fireEvent.keyDown(input, { key: 'Enter' });
	expect(commitJoint).toHaveBeenCalledWith('rack', 'module@left/hinge@door/open', [30], 'Open · Hinge door');
});

it("shows a studio's description, and a selected copy's assembly description and part number", () => {
	localStorage.clear();
	const ws = new WorkspaceState({ documentID: 'doc', userID: 'user', zero: {} as ParasocialZero });
	vi.spyOn(ws, 'publishPresence').mockImplementation(() => {});
	ws.asm.assemblies = nestedAssemblies().map((a) => a.id === 'module' ? { ...a, description: 'Swing-door module', partNumber: 'MOD-2' } : a);
	const rack = ws.asm.assemblies[0];
	vi.spyOn(ws, 'partTree', 'get').mockReturnValue([{ file: rack.file, name: rack.name, description: 'Two-module rack', parts: [], assemblies: [rack], instances: rack.instances, ids: rack.instances.map((i) => i.id) }]);
	const studio = render(Harness, { props: { component: PropertiesPanel, props: { ws } } });
	expect(studio.getByTestId('studio-description').textContent).toBe('Two-module rack');
	cleanup();
	ws.selectAssemblyScope('rack/module@left');
	const copy = render(Harness, { props: { component: PropertiesPanel, props: { ws } } });
	expect(copy.getByTestId('studio-description').textContent).toBe('Swing-door module');
	expect(copy.getByText('MOD-2')).toBeTruthy();
});
