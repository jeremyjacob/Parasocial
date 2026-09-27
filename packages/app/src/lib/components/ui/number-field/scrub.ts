import resizeCursor from '$lib/assets/cursors/resize-we.svg';

export const scrubCursor = `url("${resizeCursor}") 16 16, ew-resize`;

/** One drag owns its listeners and lock, including a lock granted after mouseup. */
export function startScrub(
	down: PointerEvent,
	callbacks: {
		onstart: () => void;
		onmove: (dx: number, event: MouseEvent) => void;
		onend: (moved: boolean, click: boolean) => void;
	}
) {
	const handle = down.currentTarget as HTMLElement;
	const doc = handle.ownerDocument;
	const win = doc.defaultView!;
	let active = true;
	let moved = false;
	let pending = false;
	let locked = false;
	let x = down.clientX;
	let y = down.clientY;
	let lastX = x;
	const cursor = doc.createElement('img');
	cursor.src = resizeCursor;
	cursor.alt = '';
	cursor.setAttribute('aria-hidden', 'true');
	cursor.dataset.scrubCursor = '';
	cursor.style.cssText = 'position:fixed;inset:auto;margin:0;padding:0;border:0;width:32px;height:32px;max-width:none;background:transparent;pointer-events:none;z-index:2147483647;visibility:hidden;';
	const style = doc.createElement('style');
	style.textContent = `* { cursor: ${scrubCursor} !important; user-select: none !important; }`;

	const ownsLock = () => doc.pointerLockElement === cursor;
	const wrap = (n: number, size: number) => ((n % size) + size) % size;
	function drawCursor() {
		cursor.style.left = `${x - 16}px`;
		cursor.style.top = `${y - 16}px`;
	}
	function removeLockListeners() {
		doc.removeEventListener('pointerlockchange', lockChange);
		doc.removeEventListener('pointerlockerror', lockError);
	}
	function lockChange() {
		if (ownsLock()) {
			pending = false;
			if (!active) {
				doc.exitPointerLock();
				removeLockListeners();
				cursor.remove();
				return;
			}
			if (locked) return;
			locked = true;
			cursor.style.visibility = 'visible';
			// The top layer also keeps the cursor visible over dialogs and popovers.
			if (cursor.showPopover) {
				cursor.popover = 'manual';
				cursor.showPopover();
			}
			drawCursor();
		} else if (locked) finish(); // Escape or the browser released the lock.
	}
	function lockError() {
		pending = false;
		removeLockListeners();
		cursor.remove();
		// Keep ordinary pointer capture when the browser refuses pointer lock.
	}
	function begin() {
		moved = true;
		callbacks.onstart();
		doc.head.append(style);
		if (down.pointerType !== 'mouse' || !cursor.requestPointerLock || doc.pointerLockElement) return;
		doc.body.append(cursor);
		doc.addEventListener('pointerlockchange', lockChange);
		doc.addEventListener('pointerlockerror', lockError);
		pending = true;
		try {
			// Older browsers return void; newer ones also reject a promise on failure.
			const request = cursor.requestPointerLock();
			request?.then(lockChange, lockError);
		} catch {
			lockError();
		}
	}
	function pointerMove(e: PointerEvent) {
		if (e.pointerId !== down.pointerId || ownsLock()) return;
		if (!(e.buttons & 1)) return finish();
		const dx = e.clientX - lastX;
		lastX = e.clientX;
		x = e.clientX;
		y = e.clientY;
		if (!moved) {
			if (Math.abs(x - down.clientX) < 3) return;
			begin();
		}
		callbacks.onmove(dx, e);
	}
	function mouseMove(e: MouseEvent) {
		if (!ownsLock()) return;
		if (!(e.buttons & 1)) return finish();
		x = wrap(x + e.movementX, win.innerWidth);
		y = wrap(y + e.movementY, win.innerHeight);
		drawCursor();
		callbacks.onmove(e.movementX, e);
	}
	function pointerUp(e: PointerEvent) {
		if (e.pointerId === down.pointerId) finish(true);
	}
	function pointerCancel(e: PointerEvent) {
		if (e.pointerId === down.pointerId) finish();
	}
	function mouseUp(e: MouseEvent) {
		if (e.button === 0) finish(true);
	}
	function keyDown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			finish();
		}
	}
	function blur() { finish(); }
	function visibility() { if (doc.hidden) finish(); }
	function finish(click = false) {
		if (!active) return;
		active = false;
		win.removeEventListener('pointermove', pointerMove);
		win.removeEventListener('mousemove', mouseMove);
		win.removeEventListener('pointerup', pointerUp);
		win.removeEventListener('mouseup', mouseUp);
		win.removeEventListener('pointercancel', pointerCancel);
		win.removeEventListener('keydown', keyDown, true);
		win.removeEventListener('blur', blur);
		doc.removeEventListener('visibilitychange', visibility);
		if (handle.hasPointerCapture(down.pointerId)) handle.releasePointerCapture(down.pointerId);
		style.remove();
		cursor.style.visibility = 'hidden';
		if (ownsLock()) doc.exitPointerLock();
		// Wait for an outstanding request before removing its unique lock target.
		if (!pending) {
			removeLockListeners();
			cursor.remove();
		}
		callbacks.onend(moved, click && !moved);
	}

	handle.setPointerCapture(down.pointerId);
	win.addEventListener('pointermove', pointerMove);
	win.addEventListener('mousemove', mouseMove);
	win.addEventListener('pointerup', pointerUp);
	win.addEventListener('mouseup', mouseUp);
	win.addEventListener('pointercancel', pointerCancel);
	win.addEventListener('keydown', keyDown, true);
	win.addEventListener('blur', blur);
	doc.addEventListener('visibilitychange', visibility);
	return () => finish();
}
