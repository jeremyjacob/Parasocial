<script lang="ts">
	// Concept "Duo": the app's own avatar language. Agents are graphite squircles, humans are
	// circles; the human sits in front, cut out of the agent the way stacked avatars overlap.
	let { size = 28, class: className = '' }: { size?: number; class?: string } = $props();
	const id = $props.id();
</script>

<svg viewBox="0 0 32 32" width={size} height={size} class={className} aria-hidden="true">
	<defs>
		<mask id="{id}-m" maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32">
			<rect width="32" height="32" fill="#fff" />
			<circle cx="12" cy="19.5" r="11.25" fill="#000" />
		</mask>
	</defs>
	<rect x="12" y="2.5" width="17.5" height="17.5" rx="5.5" fill="var(--fg-primary)" mask="url(#{id}-m)" />
	<circle cx="12" cy="19.5" r="9" fill="var(--accent)" />
</svg>
