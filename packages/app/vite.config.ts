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
	server: { headers: isolation },
	preview: { headers: isolation },
	resolve: process.env.VITEST ? { conditions: ['browser'] } : undefined,
	test: {
		environment: 'happy-dom',
		include: ['src/**/*.test.ts']
	}
});
