import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startScrub } from './scrub';
import resizeCursor from '$lib/assets/cursors/resize-we.svg';

let lock: Element | null;
let request: ReturnType<typeof vi.fn>;
let end: (() => void) | undefined;
const originalRequest = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'requestPointerLock');
const originalExit = Object.getOwnPropertyDescriptor(document, 'exitPointerLock');
const originalLock = Object.getOwnPropertyDescriptor(document, 'pointerLockElement');

beforeEach(() => {
	lock = null;
	request = vi.fn(); // The event-only API is still supported by browsers.
	Object.defineProperty(HTMLElement.prototype, 'requestPointerLock', { configurable: true, value: request });
	Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => lock });
	Object.defineProperty(document, 'exitPointerLock', { configurable: true, value: vi.fn(() => {
		lock = null;
		document.dispatchEvent(new Event('pointerlockchange'));
	}) });
});

afterEach(() => {
	end?.();
	// Settle any deliberately delayed request to remove its listeners.
	document.dispatchEvent(new Event('pointerlockerror'));
	document.body.replaceChildren();
	for (const [object, key, descriptor] of [
		[HTMLElement.prototype, 'requestPointerLock', originalRequest],
		[document, 'exitPointerLock', originalExit],
		[document, 'pointerLockElement', originalLock]
	] as const) {
		if (descriptor) Object.defineProperty(object, key, descriptor);
		else Reflect.deleteProperty(object, key);
	}
});

function setup(pointerType = 'mouse') {
	const handle = document.createElement('span');
	handle.setPointerCapture = vi.fn();
	handle.hasPointerCapture = () => true;
	handle.releasePointerCapture = vi.fn();
	document.body.append(handle);
	const callbacks = { onstart: vi.fn(), onmove: vi.fn(), onend: vi.fn() };
	handle.addEventListener('pointerdown', (event) => { end = startScrub(event, callbacks); });
	handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, pointerType, button: 0, buttons: 1, clientX: 100, clientY: 100 }));
	return callbacks;
}

function move(clientX: number, pointerId = 1) {
	window.dispatchEvent(new PointerEvent('pointermove', { pointerId, buttons: 1, clientX, clientY: 100 }));
}

function grantLock() {
	const cursor = document.querySelector<HTMLImageElement>('[data-scrub-cursor]')!;
	lock = cursor;
	document.dispatchEvent(new Event('pointerlockchange'));
	return cursor;
}

describe('number field scrubbing', () => {
	it('preserves a click without requesting lock', () => {
		const callbacks = setup();
		move(102);
		window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
		expect(request).not.toHaveBeenCalled();
		expect(callbacks.onend).toHaveBeenCalledExactlyOnceWith(false, true);
	});

	it('uses relative motion under lock, wraps both edges, and ends once on release', () => {
		const callbacks = setup();
		move(104);
		const cursor = grantLock();
		expect(cursor.getAttribute('src')).toBe(resizeCursor);
		callbacks.onmove.mockClear();
		const dx = window.innerWidth * 2 + 20;
		window.dispatchEvent(new MouseEvent('mousemove', { buttons: 1, movementX: dx, movementY: -120, shiftKey: true }));
		expect(cursor.style.left).toBe('108px'); // (104 + 20) - hotspot
		expect(cursor.style.top).toBe(`${window.innerHeight - 36}px`);
		expect(callbacks.onmove).toHaveBeenCalledExactlyOnceWith(dx, expect.objectContaining({ shiftKey: true }));
		move(500); // Pointer events must not apply the same locked movement again.
		expect(callbacks.onmove).toHaveBeenCalledTimes(1);
		window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
		window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
		expect(callbacks.onend).toHaveBeenCalledExactlyOnceWith(true, false);
		expect(lock).toBeNull();
		expect(cursor.isConnected).toBe(false);
	});

	it.each(['escape', 'blur', 'cancel', 'unlock', 'destroy'])('releases the cursor on %s', (reason) => {
		const callbacks = setup();
		move(104);
		const cursor = grantLock();
		if (reason === 'escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		if (reason === 'blur') window.dispatchEvent(new Event('blur'));
		if (reason === 'cancel') window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
		if (reason === 'unlock') { lock = null; document.dispatchEvent(new Event('pointerlockchange')); }
		if (reason === 'destroy') end?.();
		expect(callbacks.onend).toHaveBeenCalledExactlyOnceWith(true, false);
		expect(cursor.isConnected).toBe(false);
		expect(lock).toBeNull();
	});

	it('immediately releases a lock granted after the drag has ended', () => {
		const callbacks = setup();
		move(104);
		window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
		const cursor = grantLock();
		expect(lock).toBeNull();
		expect(cursor.isConnected).toBe(false);
		expect(callbacks.onend).toHaveBeenCalledOnce();
	});

	it('keeps dragging normally when pointer lock is rejected', async () => {
		request.mockRejectedValue(new Error('Pointer lock denied'));
		const callbacks = setup();
		move(104);
		await Promise.resolve();
		move(114);
		expect(callbacks.onmove).toHaveBeenLastCalledWith(10, expect.any(PointerEvent));
		expect(document.querySelector('[data-scrub-cursor]')).toBeNull();
		window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
		expect(callbacks.onend).toHaveBeenCalledExactlyOnceWith(true, false);
	});

	it('supports touch movement without pointer lock and ignores other pointers', () => {
		const callbacks = setup('touch');
		move(104, 2);
		expect(callbacks.onstart).not.toHaveBeenCalled();
		move(104);
		expect(callbacks.onmove).toHaveBeenCalledExactlyOnceWith(4, expect.any(PointerEvent));
		expect(request).not.toHaveBeenCalled();
	});
});
