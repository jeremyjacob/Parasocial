<script lang="ts">
	// Concept "Pin": a note pin (round with one sharp corner, the comment-pin shape) holding a
	// solid. A note, placed on geometry. Uses the semantic tokens directly so any data-theme
	// scope re-themes it (the @theme --color-* aliases resolve at :root).
	let { size = 28, class: className = '' }: { size?: number; class?: string } = $props();
</script>

<svg viewBox="0 0 32 32" width={size} height={size} class={className} aria-hidden="true">
	<path d="M16 2.5A13.5 13.5 0 1 1 16 29.5H2.5V16A13.5 13.5 0 0 1 16 2.5Z" fill="var(--accent)" />
	<g fill="var(--fg-on-accent)" stroke="var(--fg-on-accent)" stroke-width=".6" stroke-linejoin="round">
		<path d="M16 6.9 23.2 11.05 16 15.2 8.8 11.05Z" />
		<path d="M8.8 12.6 15.2 16.3v8.2l-6.4-3.7Z" opacity=".74" />
		<path d="M23.2 12.6 16.8 16.3v8.2l6.4-3.7Z" opacity=".44" />
	</g>
</svg>
