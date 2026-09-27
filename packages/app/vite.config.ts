import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

// The app runs cross-origin isolated (threaded OCCT needs SharedArrayBuffer),
// so every asset must come from our own origin. Mirror the headers in dev.
const isolation = {
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Cross-Origin-Embedder-Policy': 'require-corp'
};

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	server: {
		headers: isolation,
		// zero-cache (docker) calls back into the dev server for mutators and synced queries
		allowedHosts: ['host.docker.internal'],
		// zero-cache must be same-origin so the session cookie reaches it (see packages/sync/README.md)
		proxy: { '/zero': { target: process.env.ZERO_CACHE_URL ?? 'http://localhost:4848', ws: true, rewrite: (p) => p.replace(/^\/zero/, '') } }
	},
	preview: { headers: isolation },
	resolve: process.env.VITEST ? { conditions: ['browser'] } : undefined,
	test: {
		environment: 'happy-dom',
		include: ['src/**/*.test.ts']
	}
});
