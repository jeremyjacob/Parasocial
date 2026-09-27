export type ToastKind = 'default' | 'success' | 'error' | 'loading';

export interface ToastOptions {
	kind?: ToastKind;
	/** ms before auto-dismiss; 0 keeps it until dismissed. Errors default to 6000, others 3500. */
	duration?: number;
	action?: { label: string; onClick: () => void };
}

export interface ToastData extends Required<Pick<ToastOptions, 'kind'>> {
	id: number;
	message: string;
	action?: ToastOptions['action'];
	duration: number;
}

let nextId = 1;

class ToastStore {
	items = $state.raw<ToastData[]>([]);
	#timers = new Map<number, ReturnType<typeof setTimeout>>();

	show(message: string, opts: ToastOptions = {}): number {
		const kind = opts.kind ?? 'default';
		const duration = opts.duration ?? (kind === 'error' ? 6000 : kind === 'loading' ? 0 : 3500);
		const t: ToastData = { id: nextId++, message, kind, action: opts.action, duration };
		// Keep at most 3 visible; newest at the bottom (closest to the user's focus).
		this.items = [...this.items.slice(-2), t];
		if (duration) this.#timers.set(t.id, setTimeout(() => this.dismiss(t.id), duration));
		return t.id;
	}

	update(id: number, message: string, opts: ToastOptions = {}) {
		this.items = this.items.map((t) => (t.id === id ? { ...t, message, kind: opts.kind ?? t.kind, action: opts.action } : t));
		const duration = opts.duration ?? 3500;
		clearTimeout(this.#timers.get(id));
		if (duration) this.#timers.set(id, setTimeout(() => this.dismiss(id), duration));
	}

	dismiss(id: number) {
		clearTimeout(this.#timers.get(id));
		this.#timers.delete(id);
		this.items = this.items.filter((t) => t.id !== id);
	}
}

export const toasts = new ToastStore();

export const toast = Object.assign((message: string, opts?: ToastOptions) => toasts.show(message, opts), {
	success: (m: string, o?: ToastOptions) => toasts.show(m, { ...o, kind: 'success' }),
	error: (m: string, o?: ToastOptions) => toasts.show(m, { ...o, kind: 'error' }),
	loading: (m: string, o?: ToastOptions) => toasts.show(m, { ...o, kind: 'loading' }),
	dismiss: (id: number) => toasts.dismiss(id)
});
