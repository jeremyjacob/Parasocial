// Commands and shortcuts (§8 Keyboard). Every action has a shortcut; the ⌘K palette lists all
// of them. Shortcuts avoid browser-reserved keys and are customizable (overrides in localStorage).
import type { LucideIcon } from '@lucide/svelte';

export type Command = {
	id: string;
	label: string;
	group: string;
	/** Default keys, e.g. ['mod','shift','E'] or ['V']. */
	keys?: string[];
	icon?: LucideIcon;
	keywords?: string[];
	/** Hold-to-activate (B flashes the before state). */
	hold?: boolean;
	enabled?: () => boolean;
	run: () => void;
};

const STORAGE = 'parasocial:shortcuts';

export function loadCustomKeys(): Record<string, string[]> {
	try {
		return JSON.parse(localStorage.getItem(STORAGE) ?? '{}');
	} catch {
		return {};
	}
}

export function saveCustomKeys(map: Record<string, string[]>) {
	try {
		localStorage.setItem(STORAGE, JSON.stringify(map));
	} catch {}
}

/** Browser-reserved combinations we never bind. */
export const RESERVED = new Set(['mod+w', 'mod+t', 'mod+n', 'mod+q', 'mod+r', 'mod+l', 'mod+shift+t', 'mod+shift+n', 'mod+tab']);

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Normalize an event to a combo string: "mod+shift+e", "v", "?" */
export function comboOf(e: KeyboardEvent): string {
	const parts: string[] = [];
	if (isMac ? e.metaKey : e.ctrlKey) parts.push('mod');
	if (e.altKey) parts.push('alt');
	if (e.shiftKey && e.key.length > 1) parts.push('shift');
	else if (e.shiftKey && /^[a-z]$/i.test(e.key)) parts.push('shift');
	let k = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
	if (e.code === 'Backslash') k = '\\';
	if (e.code === 'Space') k = 'space';
	if (e.altKey && /^Digit\d$/.test(e.code)) k = e.code.slice(5);
	if (e.altKey && /^Key[A-Z]$/.test(e.code)) k = e.code.slice(3).toLowerCase();
	parts.push(k);
	return parts.join('+');
}

export function comboOfKeys(keys: string[]): string {
	return keys.map((k) => k.toLowerCase()).join('+');
}

/** Find conflicts: combos bound to more than one command. */
export function conflicts(cmds: Command[], custom: Record<string, string[]>) {
	const by = new Map<string, string[]>();
	for (const c of cmds) {
		const keys = custom[c.id] ?? c.keys;
		if (!keys) continue;
		const k = comboOfKeys(keys);
		by.set(k, [...(by.get(k) ?? []), c.id]);
	}
	return [...by].filter(([, ids]) => ids.length > 1);
}

export function isTyping(e: Event) {
	const t = e.target as HTMLElement | null;
	return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || !!t.closest('[role="dialog"] input, .monaco-editor'));
}
