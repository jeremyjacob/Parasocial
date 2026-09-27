import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Teach tailwind-merge about our custom type scale and radii so `cn('text-ui', 'text-label')`
// resolves to the last one instead of keeping both.
export const twMergeConfig = {
	extend: {
		classGroups: {
			'font-size': [{ text: ['caption', 'label', 'ui', 'body', 'section', 'title', 'heading', 'display'] }],
			rounded: [{ rounded: ['xs', 'sm', 'control', 'md', 'popover', 'panel', 'dialog', 'full'] }],
			shadow: [{ shadow: ['xs', 'control', 'thumb', 'toolbar', 'popover', 'dialog', 'focus'] }]
		}
	}
};
const merge = extendTailwindMerge(twMergeConfig);

export function cn(...inputs: ClassValue[]) {
	return merge(clsx(inputs));
}

export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Map a shortcut token to its platform glyph: mod → ⌘ / Ctrl, shift → ⇧ … */
export function keyGlyph(key: string): string {
	const k = key.toLowerCase();
	const map: Record<string, string> = {
		mod: isMac ? '⌘' : 'Ctrl',
		cmd: '⌘',
		meta: '⌘',
		ctrl: isMac ? '⌃' : 'Ctrl',
		shift: '⇧',
		alt: isMac ? '⌥' : 'Alt',
		option: '⌥',
		enter: '↵',
		return: '↵',
		backspace: '⌫',
		delete: '⌫',
		esc: 'Esc',
		escape: 'Esc',
		tab: '⇥',
		space: 'Space',
		up: '↑',
		down: '↓',
		left: '←',
		right: '→'
	};
	return map[k] ?? (key.length === 1 ? key.toUpperCase() : key);
}
