import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/svelte';
import type { Note } from '@parasocial/sync';
import type { Viewer } from '@parasocial/viewer';
import Pins from './Pins.svelte';
import { NotesController } from './notes.svelte';
import type { WorkspaceState } from './state.svelte';

afterEach(cleanup);

async function setup(status: Note['status'] = 'Open') {
	const note = {
		id: 'note', status, createdAt: 1, orphaned: false,
		anchor: { targets: [{ kind: 'studio', studio: 'studios/model.ts', point: [0, 0, 0] }] }
	} as Note;
	const ws = {
		notes: [note], scripts: [{ path: 'studios/model.ts' }], agents: [],
		studio: { file: 'studios/model.ts' }, results: {}, kernelReady: false
	} as unknown as WorkspaceState;
	const nc = new NotesController(ws);
	const viewer = { project: () => ({ x: 100, y: 100 }), on: () => () => {} } as unknown as Viewer;
	await nc.resolveAll();
	nc.active = note.id;
	nc.hovered = note.id;
	const ui = render(Pins, { props: { ws, nc, viewer, onopen: vi.fn() } });
	await waitFor(() => expect(ui.queryByTestId('pin')).not.toBeNull());
	return { ws, nc, ...ui };
}

describe('resolved note pins', () => {
	it.each(['Open', 'AgentWorking'] as const)('hides an active, hovered %s note when its synced status becomes resolved', async (status) => {
		const { ws, nc, queryByTestId } = await setup(status);
		ws.notes = [{ ...ws.notes[0], status: 'Resolved' }];
		await nc.resolveAll();
		await waitFor(() => expect(queryByTestId('pin')).toBeNull());
		expect(nc.active).toBeNull();
		expect(nc.hovered).toBeNull();

		// A later hover can still reveal its location, even after regeneration.
		nc.hovered = 'note';
		await nc.resolveAll();
		await waitFor(() => expect(queryByTestId('pin')).not.toBeNull());
		nc.hovered = null;
		await waitFor(() => expect(queryByTestId('pin')).toBeNull());
	});

	it('preserves an explicitly selected resolved note through regeneration', async () => {
		const { nc, queryByTestId } = await setup('Resolved');
		nc.hovered = null;
		await nc.resolveAll();
		expect(nc.active).toBe('note');
		await waitFor(() => expect(queryByTestId('pin')).not.toBeNull());
	});
});
