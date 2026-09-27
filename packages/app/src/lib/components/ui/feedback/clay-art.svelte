<script lang="ts">
	// Placeholder for the grayscale clay renders of example parts (PLAN §8). Real renders will be
	// AVIF/WebP made by our engine; this SVG keeps the same visual language until they exist.
	let { size = 144 }: { size?: number } = $props();
	const uid = $props.id();
</script>

<svg viewBox="0 0 160 112" width={size} height={size * 0.7} role="presentation" aria-hidden="true">
	<defs>
		<filter id="blur-{uid}" x="-50%" y="-50%" width="200%" height="200%">
			<feGaussianBlur stdDeviation="5" />
		</filter>
		<linearGradient id="top-{uid}" x1="0" y1="0" x2="1" y2="1">
			<stop offset="0" stop-color="var(--clay-top-hi)" />
			<stop offset="1" stop-color="var(--clay-top)" />
		</linearGradient>
		<linearGradient id="left-{uid}" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="var(--clay-left)" />
			<stop offset="1" stop-color="var(--clay-left-lo)" />
		</linearGradient>
		<linearGradient id="right-{uid}" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="var(--clay-right)" />
			<stop offset="1" stop-color="var(--clay-right-lo)" />
		</linearGradient>
		<linearGradient id="cyl-{uid}" x1="0" y1="0" x2="1" y2="0">
			<stop offset="0" stop-color="var(--clay-left)" />
			<stop offset="0.55" stop-color="var(--clay-left-lo)" />
			<stop offset="1" stop-color="var(--clay-right-lo)" />
		</linearGradient>
	</defs>
	<!-- contact shadow -->
	<ellipse cx="78" cy="94" rx="62" ry="9" fill="var(--clay-shadow)" filter="url(#blur-{uid})" />
	<!-- block -->
	<path d="M41.9 40 80 62v24L41.9 64Z" fill="url(#left-{uid})" />
	<path d="M80 62 118.1 40v24L80 86Z" fill="url(#right-{uid})" />
	<path d="M80 18 118.1 40 80 62 41.9 40Z" fill="url(#top-{uid})" />
	<!-- bore -->
	<ellipse cx="80" cy="40" rx="12.2" ry="7.1" fill="var(--clay-hole)" />
	<path d="M67.8 40a12.2 7.1 0 0 1 24.4 0a12.2 5 0 0 0 -24.4 0Z" fill="var(--clay-right-lo)" opacity="0.7" />
	<!-- edges: soft highlight on the top rim -->
	<path d="M41.9 40 80 62 118.1 40" fill="none" stroke="var(--clay-edge)" stroke-width="0.75" />
	<!-- boss -->
	<path d="M28.8 67.5v14a12.2 7.1 0 0 0 24.4 0v-14Z" fill="url(#cyl-{uid})" />
	<ellipse cx="41" cy="67.5" rx="12.2" ry="7.1" fill="url(#top-{uid})" />
	<ellipse cx="41" cy="67.5" rx="4.5" ry="2.6" fill="var(--clay-hole)" />
</svg>

<style>
	svg {
		--clay-top-hi: #f4f4f5;
		--clay-top: #e2e2e5;
		--clay-left: #cfcfd3;
		--clay-left-lo: #bdbdc2;
		--clay-right: #b3b3b9;
		--clay-right-lo: #a2a2a9;
		--clay-hole: #8d8d95;
		--clay-edge: rgb(255 255 255 / 0.7);
		--clay-shadow: rgb(16 16 24 / 0.22);
	}
	:global([data-theme='dark']) svg {
		--clay-top-hi: #5a5a61;
		--clay-top: #4a4a50;
		--clay-left: #3d3d43;
		--clay-left-lo: #333338;
		--clay-right: #2e2e33;
		--clay-right-lo: #27272b;
		--clay-hole: #1d1d20;
		--clay-edge: rgb(255 255 255 / 0.12);
		--clay-shadow: rgb(0 0 0 / 0.6);
	}
</style>
