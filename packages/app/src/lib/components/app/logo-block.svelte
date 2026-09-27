<script lang="ts">
	// Concept "Block": a P extruded like a sketch pad, in oblique projection so the letter stays
	// legible. The front face is the profile; the depth is the feature. The counter is a clean
	// hole, so at 16px it stays a hole rather than grey mush.
	let { size = 28, class: className = '' }: { size?: number; class?: string } = $props();
</script>

<svg viewBox="0 0 32 32" width={size} height={size} class={className} aria-hidden="true">
	<path d="M4 9 9 4h17l-5 5Z" fill="var(--fg-primary)" opacity=".32" />
	<path d="M21 9l5-5v12l-5 5ZM11 21l5-5v8l-5 5Z" fill="var(--fg-primary)" opacity=".6" />
	<path fill-rule="evenodd" fill="var(--fg-primary)" d="M4 9h17v12H11v8H4ZM11 12.5v5h6.5v-5Z" />
	<path d="M11 12.5h6.5L11 17.5Z" fill="var(--fg-primary)" opacity=".6" />
</svg>
