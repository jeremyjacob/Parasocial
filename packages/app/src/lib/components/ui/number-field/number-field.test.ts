import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import Harness from '$lib/test/harness.svelte';
import NumberField from './number-field.svelte';
import { createEvaluator } from './evaluate';
import { RotateCw } from '@lucide/svelte';

afterEach(() => cleanup());

function setup(props: Record<string, unknown> = {}) {
	const oncommit = vi.fn();
	const oninput = vi.fn();
	const onreset = vi.fn();
	const utils = render(Harness, {
		props: {
			component: NumberField,
			props: { value: 10, label: 'W', 'aria-label': 'Width', oncommit, oninput, onreset, ...props }
		}
	});
	const input = utils.getByRole('spinbutton') as HTMLInputElement;
	return { ...utils, input, oncommit, oninput, onreset };
}

async function type(input: HTMLInputElement, text: string) {
	await fireEvent.focus(input);
	await fireEvent.input(input, { target: { value: text } });
}

describe('NumberField', () => {
	it('steps with arrow keys, with Shift (coarse) and Alt (fine) modifiers', async () => {
		const { input, oncommit } = setup({ step: 1 });
		await fireEvent.focus(input);
		await fireEvent.keyDown(input, { key: 'ArrowUp' });
		expect(oncommit).toHaveBeenLastCalledWith(11, undefined);
		await fireEvent.keyDown(input, { key: 'ArrowUp', shiftKey: true });
		expect(oncommit).toHaveBeenLastCalledWith(21, undefined);
		await fireEvent.keyDown(input, { key: 'ArrowDown', altKey: true });
		expect(oncommit).toHaveBeenLastCalledWith(20.9, undefined);
	});

	it('clamps stepping to bounds', async () => {
		const { input, oncommit } = setup({ value: 9, max: 10 });
		await fireEvent.focus(input);
		await fireEvent.keyDown(input, { key: 'ArrowUp', shiftKey: true });
		expect(oncommit).toHaveBeenLastCalledWith(10, undefined);
		expect(input.getAttribute('aria-valuenow')).toBe('10');
	});

	it('rejects typed values outside the bounds inline, with the bound shown', async () => {
		const { input, oncommit, getByRole } = setup({ max: 20, unit: 'mm' });
		await type(input, '25');
		expect(getByRole('alert').textContent).toBe('Max 20 mm');
		await fireEvent.keyDown(input, { key: 'Enter' });
		expect(oncommit).not.toHaveBeenCalled();
		expect(input.getAttribute('aria-invalid')).toBe('true');
	});

	it('evaluates expressions through the pluggable evaluator and stores them as typed', async () => {
		const evaluate = vi.fn(createEvaluator({ scope: { width: 120 } }));
		const { input, oncommit } = setup({ evaluate });
		await type(input, '=width/4');
		await fireEvent.keyDown(input, { key: 'Enter' });
		expect(evaluate).toHaveBeenCalledWith('=width/4');
		expect(oncommit).toHaveBeenLastCalledWith(30, '=width/4');
		await fireEvent.blur(input);
		expect(input.value).toBe('=width/4'); // expression shown at rest
	});

	it('shows evaluator errors and keeps the last good value', async () => {
		const { input, oncommit, getByRole } = setup();
		await type(input, '=nope');
		expect(getByRole('alert').textContent).toBe('Unknown name “nope”');
		await fireEvent.blur(input);
		expect(oncommit).not.toHaveBeenCalled();
		expect(input.value).toBe('10');
	});

	it('is overridden when the value differs from the code default, and resets', async () => {
		const { input, getByLabelText, onreset, oncommit, queryByLabelText } = setup({ value: 4, defaultValue: 3 });
		expect(input.className).toContain('text-override');
		await fireEvent.click(getByLabelText('Reset to default'));
		expect(onreset).toHaveBeenCalled();
		expect(oncommit).not.toHaveBeenCalled();
		expect(input.getAttribute('aria-valuenow')).toBe('3');
		expect(queryByLabelText('Reset to default')).toBeNull();
	});

	it('resets with ⌘⌫ on a focused overridden field', async () => {
		const { input, onreset } = setup({ value: 4, defaultValue: 3 });
		await fireEvent.focus(input);
		await fireEvent.keyDown(input, { key: 'Backspace', metaKey: true });
		expect(onreset).toHaveBeenCalled();
	});

	it('double-clicking a joint icon resets to its nonzero default and clears the expression', async () => {
		const { input, getByTitle, onreset, oncommit } = setup({
			icon: RotateCw, value: 45, defaultValue: 15, expression: '=90/2', unit: '°'
		});
		await fireEvent.doubleClick(getByTitle('Drag to adjust · Double-click to reset to 15 °'));
		expect(input.value).toBe('15');
		expect(onreset).toHaveBeenCalledOnce();
		expect(oncommit).not.toHaveBeenCalled();
	});

	it('commits the default on reset when there is no onreset', async () => {
		const { getByLabelText, oncommit } = setup({ value: 4, defaultValue: 3, onreset: undefined });
		await fireEvent.click(getByLabelText('Reset to default'));
		expect(oncommit).toHaveBeenLastCalledWith(3, undefined);
	});

	it('does not reset disabled handles or handles without defaults', async () => {
		const disabled = setup({ disabled: true, defaultValue: 5 });
		await fireEvent.doubleClick(disabled.getByTitle('Drag to adjust · Double-click to reset to 5'));
		expect(disabled.oncommit).not.toHaveBeenCalled();
		disabled.unmount();
		const noDefault = setup();
		await fireEvent.doubleClick(noDefault.getByTitle('Drag to adjust'));
		expect(noDefault.oncommit).not.toHaveBeenCalled();
	});

	it('Escape reverts the draft', async () => {
		const { input, oncommit } = setup();
		await type(input, '99');
		await fireEvent.keyDown(input, { key: 'Escape' });
		await fireEvent.blur(input);
		expect(oncommit).not.toHaveBeenCalled();
		expect(input.value).toBe('10');
	});
});
