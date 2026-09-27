<script lang="ts">
	// Concept "Face": a solid with its top face picked out in the accent and lifted off the body,
	// the moment you click a face to leave a note on it. Semantic tokens (not the @theme
	// --color-* aliases) so nested data-theme scopes re-theme it.
	let { size = 28, class: className = '' }: { size?: number; class?: string } = $props();
</script>

<svg viewBox="0 0 32 32" width={size} height={size} class={className} aria-hidden="true">
	<g stroke-width="1.2" stroke-linejoin="round">
		<path d="M5 13.9 15.4 19.9v9.2L5 23.1Z" fill="var(--fg-primary)" stroke="var(--fg-primary)" opacity=".86" />
		<path d="M27 13.9 16.6 19.9v9.2L27 23.1Z" fill="var(--fg-primary)" stroke="var(--fg-primary)" opacity=".42" />
		<path d="M16 3 27 9.35 16 15.7 5 9.35Z" fill="var(--accent)" stroke="var(--accent)" />
	</g>
</svg>
