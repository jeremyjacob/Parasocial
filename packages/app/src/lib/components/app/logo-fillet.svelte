<script lang="ts">
	// Concept "Fillet": a P drawn like a sketch profile. The bowl is a single fillet and its
	// centre is marked in the accent, the way a CAD sketch shows a radius's construction point.
	let { size = 28, class: className = '' }: { size?: number; class?: string } = $props();
</script>

<svg viewBox="0 0 32 32" width={size} height={size} class={className} aria-hidden="true">
	<path fill-rule="evenodd" fill="var(--fg-primary)" d="M7 3h11a9 9 0 0 1 0 18h-5.5v8H7ZM12.5 8v8H18a4 4 0 0 0 0-8Z" />
	<circle cx="18" cy="12" r="2.3" fill="var(--accent)" />
</svg>
