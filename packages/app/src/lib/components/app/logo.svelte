<script lang="ts">
	// The Parasocial mark: a hexagonal ring, shaded from its rim inward. Both stops derive from the
	// semantic fg token so nested data-theme scopes re-theme it.
	let { size = 20 }: { size?: number } = $props();
	const id = $props.id();
</script>

<svg viewBox="8 8 108 108" width={size} height={size} class="shrink-0" aria-hidden="true">
	<defs>
		<radialGradient id="{id}-g" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(62 62) rotate(90) scale(53.9431 48.4893)">
			<stop offset=".476" style="stop-color: color-mix(in oklab, var(--fg-primary) 70%, transparent)" />
			<stop offset=".976" style="stop-color: var(--fg-primary)" />
		</radialGradient>
	</defs>
	<path fill-rule="evenodd" fill="url(#{id}-g)" d="M55.3839 9.82878C59.4778 7.46516 64.5223 7.46613 68.6163 9.82976L103.873 30.1852C107.967 32.5489 110.489 36.917 110.489 41.6442V82.3551C110.489 87.0823 107.967 91.4505 103.873 93.8141L68.6163 114.171C64.5223 116.534 59.4778 116.534 55.3839 114.171L20.127 93.8141C16.0332 91.4505 13.5108 87.0824 13.5108 82.3551V41.6442C13.5108 36.917 16.0331 32.5489 20.127 30.1852L55.3839 9.82878ZM65.6143 36.1276C63.3776 34.8363 60.6216 34.8362 58.3848 36.1276L41.4014 45.9333C39.1646 47.2247 37.7862 49.6112 37.7862 52.194V71.8053C37.7862 74.3882 39.1646 76.7747 41.4014 78.0661L58.3848 87.8718C60.6216 89.1631 63.3775 89.1631 65.6143 87.8718L82.5987 78.0661C84.8354 76.7747 86.213 74.3881 86.213 71.8053V52.194C86.2129 49.6112 84.8355 47.2247 82.5987 45.9333L65.6143 36.1276Z" />
</svg>
