<script lang="ts">
	// Soft backdrop for sign-in: a clay render of our example parts (made by scripts/render-art.ts),
	// light and dark variants, no WASM needed. Blurred toward the edges so the card stays the focus.
	import { cn } from '$lib/utils';
	let { class: className = '', name = 'hero', fit = 'cover' }: { class?: string; name?: string; fit?: 'cover' | 'contain' } = $props();
</script>

<div class={cn('hero-art', className)} style:--fit={fit} aria-hidden="true">
	<picture class="art-light">
		<source srcset="/art/{name}-light.avif" type="image/avif" />
		<img src="/art/{name}-light.webp" alt="" />
	</picture>
	<picture class="art-dark">
		<source srcset="/art/{name}-dark.avif" type="image/avif" />
		<img src="/art/{name}-dark.webp" alt="" />
	</picture>
</div>

<style>
	.hero-art {
		overflow: hidden;
	}
	.hero-art img {
		object-fit: var(--fit, cover) !important;
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
		object-position: center;
		opacity: 0.9;
		mask-image: radial-gradient(ellipse 75% 70% at 50% 50%, black 30%, transparent 100%);
	}
	.hero-art picture {
		display: contents;
	}
	.art-dark {
		display: none !important;
	}
	:global([data-theme='dark']) .hero-art .art-light {
		display: none !important;
	}
	:global([data-theme='dark']) .hero-art .art-dark {
		display: contents !important;
	}
</style>
