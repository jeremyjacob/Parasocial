/**
 * Design tokens for non-CSS consumers (the Three.js viewer, canvas overlays, tests).
 *
 * The literal values mirror tokens.css. When a live, theme-correct value is needed at runtime
 * prefer `readToken('--selection-preselect')`, which reads the computed CSS var (so a scoped
 * data-theme is respected); the constants below are the fallback and the source for code that
 * runs without a DOM (workers, the engine pool).
 */

export type ThemeName = 'light' | 'dark';

export interface SelectionColors {
	/** Hover stroke. */
	preselect: string;
	/** Selected entity stroke / edge colour. */
	selectedStroke: string;
	/** Selected face tint (opaque colour; pair with selectedFillOpacity). */
	selectedFill: string;
	selectedFillOpacity: number;
}

export const selection: Record<ThemeName, SelectionColors> = {
	light: {
		preselect: '#ff9933',
		selectedStroke: '#f77f00',
		selectedFill: '#ff921e',
		selectedFillOpacity: 0.5
	},
	dark: {
		preselect: '#ffa347',
		selectedStroke: '#ff8c1a',
		selectedFill: '#ff9628',
		selectedFillOpacity: 0.46
	}
};

export interface PartColor {
	id: string;
	name: string;
	/** Base colour for shaded parts on a light canvas. */
	light: string;
	/** Slightly deeper variant for a dark canvas (avoids glare, keeps edges readable). */
	dark: string;
}

/**
 * Curated part palette, assigned round-robin (Onshape style). Deliberately excludes orange
 * (selection) and the accent blue hue band (~200–225°). Mid-value, low-to-moderate chroma so
 * shading, AO and orange selection all read clearly on top.
 */
export const partColors: readonly PartColor[] = [
	{ id: 'graphite', name: 'Graphite', light: '#8e939a', dark: '#7d828a' },
	{ id: 'sage', name: 'Sage', light: '#93b29c', dark: '#7b9a84' },
	{ id: 'iris', name: 'Iris', light: '#8d8fd6', dark: '#7779be' },
	{ id: 'straw', name: 'Straw', light: '#d2c27f', dark: '#b7a86a' },
	{ id: 'teal', name: 'Teal', light: '#5fa6a4', dark: '#4f908e' },
	{ id: 'rose', name: 'Rose', light: '#cf96a4', dark: '#b37f8c' },
	{ id: 'chalk', name: 'Chalk', light: '#d9d5cc', dark: '#b9b5ad' },
	{ id: 'pine', name: 'Pine', light: '#5e8f78', dark: '#4f7d68' },
	{ id: 'plum', name: 'Plum', light: '#a189b6', dark: '#8b74a0' },
	{ id: 'moss', name: 'Moss', light: '#a3aa6e', dark: '#8a915a' }
] as const;

/** Round-robin assignment: the nth part in a document gets partColorAt(n). */
export function partColorAt(index: number): PartColor {
	const n = partColors.length;
	return partColors[((index % n) + n) % n];
}

/** Pale identity tints for human avatars (dark initials on top). No orange, no accent blue. */
export const avatarTints: readonly string[] = [
	'#c9d6cf',
	'#d3cfe6',
	'#e6d9b8',
	'#cfe0e0',
	'#e6cfd6',
	'#d8d8d0',
	'#cdd0e8'
];

export const accent: Record<ThemeName, string> = { light: '#1273eb', dark: '#2f7ff0' };

export const status: Record<ThemeName, { ok: string; warning: string; error: string; info: string }> = {
	light: { ok: '#1f9a54', warning: '#b98300', error: '#dc3b40', info: '#1273eb' },
	dark: { ok: '#3cc57a', warning: '#f0bb3c', error: '#ff5f64', info: '#5a9dff' }
};

/** Viewport backdrop colours (the canvas surface behind the 3D scene). */
export const canvas: Record<ThemeName, { background: string; grid: string }> = {
	light: { background: '#f3f3f5', grid: 'rgba(16,16,24,0.06)' },
	dark: { background: '#141416', grid: 'rgba(255,255,255,0.045)' }
};

export const motion = {
	durationInstant: 80,
	durationFast: 150,
	durationBase: 200,
	durationSlow: 250,
	/** CSS cubic-bezier control points, usable with a JS bezier easer for camera moves. */
	easeOut: [0.22, 1, 0.36, 1] as const,
	easeInOut: [0.65, 0, 0.35, 1] as const,
	easeSpring: [0.34, 1.4, 0.64, 1] as const
};

export const radius = {
	xs: 2,
	sm: 4,
	control: 6,
	md: 8,
	popover: 10,
	panel: 12,
	dialog: 14
};

/** Concentric nesting: the radius of an element inset by `padding` inside a container with `outer` radius. */
export function innerRadius(outer: number, padding: number): number {
	return Math.max(0, outer - padding);
}

/** True when the user asked for reduced motion. Animation code (camera, cross-fades) must check this. */
export function prefersReducedMotion(): boolean {
	return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Read a live token value from the DOM (respects data-theme scoping on `el`). */
export function readToken(name: `--${string}`, el: Element = document.documentElement): string {
	return getComputedStyle(el).getPropertyValue(name).trim();
}

/** Which theme is in effect for `el` (nearest data-theme ancestor). */
export function themeOf(el: Element = document.documentElement): ThemeName {
	const scoped = el.closest('[data-theme]');
	return scoped?.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}
