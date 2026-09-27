<script lang="ts">
	// Isolate: one body kept, the rest ghosted. Off = outlined; on = the kept body filled.
	let { on = false, size = 16 }: { on?: boolean; size?: number } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
	<rect x="8" y="8" width="8" height="8" rx="1.5" fill={on ? 'currentColor' : 'none'} />
	<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" opacity={on ? 1 : 0.55} />
</svg>
