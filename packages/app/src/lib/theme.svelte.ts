import { getContext, setContext } from 'svelte';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

/** Keep in sync with the inline script in app.html. */
export const THEME_STORAGE_KEY = 'parasocial:theme';

function readPreference(): ThemePreference {
	try {
		const v = localStorage.getItem(THEME_STORAGE_KEY);
		if (v === 'light' || v === 'dark' || v === 'system') return v;
	} catch {
		/* storage blocked */
	}
	return 'system';
}

/**
 * App-wide theme state. The pre-paint script has already applied data-theme to <html>;
 * this class takes over after hydration, persists changes and tracks the OS setting.
 */
class ThemeController {
	preference = $state<ThemePreference>('system');
	systemDark = $state(false);
	resolved = $derived<ResolvedTheme>(
		this.preference === 'system' ? (this.systemDark ? 'dark' : 'light') : this.preference
	);

	#started = false;

	start() {
		if (this.#started || typeof window === 'undefined') return;
		this.#started = true;
		this.preference = readPreference();
		const mq = window.matchMedia('(prefers-color-scheme: dark)');
		this.systemDark = mq.matches;
		mq.addEventListener('change', (e) => (this.systemDark = e.matches));

		$effect.root(() => {
			$effect(() => {
				const root = document.documentElement;
				root.setAttribute('data-theme', this.resolved);
				root.setAttribute('data-theme-pref', this.preference);
			});
		});
	}

	set(pref: ThemePreference) {
		this.preference = pref;
		try {
			if (pref === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
			else localStorage.setItem(THEME_STORAGE_KEY, pref);
		} catch {
			/* storage blocked: still applies for this session */
		}
	}
}

export const theme = new ThemeController();

/* -------------------------------------------------------------------------------------------- */
/* Theme scopes: a subtree that forces a theme (data-theme="dark") must also receive the         */
/* portalled content (tooltips, menus, dialogs) of its children, otherwise they'd render at      */
/* <body> with the root theme. Scopes provide a portal target via context.                       */
/* -------------------------------------------------------------------------------------------- */

const PORTAL_KEY = Symbol('portal-target');

export function setPortalTarget(get: () => HTMLElement | undefined) {
	setContext(PORTAL_KEY, get);
}

/** Returns the element floating content should portal into (defaults to body). */
export function usePortalTarget(): () => HTMLElement | string {
	const get = getContext<(() => HTMLElement | undefined) | undefined>(PORTAL_KEY);
	return () => get?.() ?? 'body';
}
