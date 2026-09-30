import adapter from 'svelte-adapter-bun';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter(),
		// the origin check is done in hooks.server.ts so native OAuth clients can reach /oauth/token
		csrf: { trustedOrigins: ['*'] }
	}
};

export default config;
