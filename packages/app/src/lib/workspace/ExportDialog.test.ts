import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import type { ParasocialZero } from '@parasocial/sync';
import Harness from '$lib/test/harness.svelte';
import { nestedAssemblies } from '$lib/test/assemblies';
import ExportDialog from './ExportDialog.svelte';
import { WorkspaceState } from './state.svelte';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('keeps the selected subassembly export and BOM scopes when its parts also fill the studio', async () => {
	localStorage.clear();
	const ws = new WorkspaceState({ documentID: 'doc', userID: 'user', zero: {} as ParasocialZero });
	vi.spyOn(ws, 'publishPresence').mockImplementation(() => {});
	const assemblies = nestedAssemblies();
	const rack = { ...assemblies[0], instances: assemblies[0].instances.slice(2, 4), subs: assemblies[0].subs.slice(0, 2) };
	ws.asm.assemblies = [rack, ...assemblies.slice(1)];
	vi.spyOn(ws, 'partTree', 'get').mockReturnValue([{ file: rack.file, name: rack.name, parts: [], assemblies: [rack], instances: rack.instances, ids: rack.instances.map((i) => i.id) }]);
	ws.selectAssemblyScope('rack/module@left/hinge@door');
	const { getByRole, getByText } = render(Harness, { props: { component: ExportDialog, props: { ws, open: true, target: rack.instances.map((i) => i.id) } } });
	expect(getByRole('button', { name: 'Parts to export' }).textContent).toContain('Rack › Module left › Hinge door (2 parts)');
	await fireEvent.click(getByText('BOM', { exact: true }));
	expect(getByRole('button', { name: 'Bill of materials for' }).textContent).toContain('Rack › Module left › Hinge door (subassembly)');
});

it('opens geometry and BOM export for the second assembly exported by a studio', async () => {
	localStorage.clear();
	const ws = new WorkspaceState({ documentID: 'doc', userID: 'user', zero: {} as ParasocialZero });
	vi.spyOn(ws, 'publishPresence').mockImplementation(() => {});
	const [rack, module, hinge] = nestedAssemblies();
	module.instances = [{ id: 'module/parts:lid', part: 'parts:lid', scope: 'module' }];
	ws.asm.assemblies = [rack, module, hinge];
	const instances = [...rack.instances, ...module.instances];
	vi.spyOn(ws, 'partTree', 'get').mockReturnValue([{ file: rack.file, name: rack.name, parts: [], assemblies: [rack, module], instances, ids: instances.map((i) => i.id) }]);
	ws.selectAssemblyScope('module');
	const { getByRole, getByText } = render(Harness, { props: { component: ExportDialog, props: { ws, open: true, target: ['module/parts:lid'] } } });
	expect(getByRole('button', { name: 'Parts to export' }).textContent).toContain('Module (1 parts)');
	await fireEvent.click(getByText('BOM', { exact: true }));
	expect(getByRole('button', { name: 'Bill of materials for' }).textContent).toContain('Module (assembly)');
});
