/**
 * Svelte transitions tuned to the motion tokens (DESIGN.md → Elevation, focus, motion).
 *
 * Svelte transitions run through the Web Animations API, so the global reduced-motion CSS
 * rule doesn't reach them: every helper here collapses to 0 ms when the user asks for reduced
 * motion. They're all short (≤ 250 ms, `pop` ≤ 350 ms), ease-out, and never gate input: elements are
 * interactive from their first frame and an interrupted transition reverses from where it is.
 */
import type { TransitionConfig } from 'svelte/transition';
import { motion, prefersReducedMotion } from './tokens';

/** CSS cubic-bezier(0.22, 1, 0.36, 1) (`--ease-out`) as a JS easing. */
export const easeOut = bezier(...motion.easeOut);

function bezier(x1: number, y1: number, x2: number, y2: number) {
	const cx = 3 * x1,
		bx = 3 * (x2 - x1) - cx,
		ax = 1 - cx - bx;
	const cy = 3 * y1,
		by = 3 * (y2 - y1) - cy,
		ay = 1 - cy - by;
	const x = (t: number) => ((ax * t + bx) * t + cx) * t;
	const y = (t: number) => ((ay * t + by) * t + cy) * t;
	const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
	return (p: number) => {
		if (p <= 0) return 0;
		if (p >= 1) return 1;
		let t = p;
		for (let i = 0; i < 6; i++) {
			const d = dx(t);
			if (Math.abs(d) < 1e-6) break;
			t -= (x(t) - p) / d;
		}
		return y(Math.min(1, Math.max(0, t)));
	};
}

const dur = (ms: number) => (prefersReducedMotion() ? 0 : ms);

type Opts = { duration?: number; delay?: number; x?: number; y?: number; scale?: number; origin?: string };

/**
 * Fade + small offset + slight scale. The workhorse for popovers, cards and chips appearing.
 * Composes with any existing transform on the node (Tailwind v4 centring uses `translate`, which is
 * a separate property, so it's untouched).
 */
export function rise(node: Element, { duration = motion.durationFast, delay = 0, x = 0, y = 4, scale = 1, origin }: Opts = {}): TransitionConfig {
	if (origin) (node as HTMLElement).style.transformOrigin = origin;
	return {
		duration: dur(duration),
		delay: prefersReducedMotion() ? 0 : delay,
		easing: easeOut,
		css: (t, u) => `opacity:${t};transform:translate(${u * x}px,${u * y}px) scale(${scale + (1 - scale) * t})`
	};
}

/** Ease-out with a small overshoot (a gentle spring settling). */
function backOut(t: number) {
	const s = 1.4,
		u = t - 1;
	return u * u * ((s + 1) * u + s) + 1;
}

/**
 * Drop in from above with a slight springy overshoot, for a toolbar that appears on a command
 * (section view). Pair with `popOut`.
 */
export function pop(node: Element, { duration = 340, delay = 0, y = -14, scale = 0.9, origin }: Opts = {}): TransitionConfig {
	if (origin) (node as HTMLElement).style.transformOrigin = origin;
	return {
		duration: dur(duration),
		delay: prefersReducedMotion() ? 0 : delay,
		easing: backOut,
		css: (t, u) => `opacity:${Math.min(1, t * 2.5)};transform:translateY(${u * y}px) scale(${scale + (1 - scale) * t})`
	};
}

/** `pop` in reverse, quicker: lifts away, shrinking a touch. */
export function popOut(_node: Element, { duration = 160, delay = 0, y = -10, scale = 0.94 }: Opts = {}): TransitionConfig {
	return {
		duration: dur(duration),
		delay,
		easing: (t) => t * t,
		css: (t, u) => `opacity:${t};transform:translateY(${u * y}px) scale(${scale + (1 - scale) * t})`
	};
}

/** Quick fade, for exits (exits are faster than entrances). */
export function fadeOut(_node: Element, { duration = 100, delay = 0 }: { duration?: number; delay?: number } = {}): TransitionConfig {
	return { duration: dur(duration), delay, easing: easeOut, css: (t) => `opacity:${t}` };
}

/** Height reveal with a fade (disclosure bodies, banners). */
export function reveal(node: Element, { duration = motion.durationBase, delay = 0 }: { duration?: number; delay?: number } = {}): TransitionConfig {
	const style = getComputedStyle(node);
	const h = parseFloat(style.height);
	const pt = parseFloat(style.paddingTop);
	const pb = parseFloat(style.paddingBottom);
	const mt = parseFloat(style.marginTop);
	const mb = parseFloat(style.marginBottom);
	return {
		duration: dur(duration),
		delay,
		easing: easeOut,
		css: (t) =>
			`overflow:hidden;opacity:${Math.min(1, t * 1.6)};height:${t * h}px;padding-top:${t * pt}px;padding-bottom:${t * pb}px;margin-top:${t * mt}px;margin-bottom:${t * mb}px`
	};
}

/** Duration for `animate:flip`, respecting reduced motion. */
export const flipDuration = () => dur(motion.durationBase);
