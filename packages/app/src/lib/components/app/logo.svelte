<script lang="ts">
	let { size = 28 }: { size?: number } = $props();
</script>

<span class="grid shrink-0 place-items-center rounded-md bg-fg text-panel" style:width="{size}px" style:height="{size}px">
	<svg viewBox="0 0 24 24" width={size * 0.58} height={size * 0.58} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 20 7.5v9L12 21 4 16.5v-9L12 3Z" /><path d="M12 12 20 7.5M12 12v9M12 12 4 7.5" /></svg>
</span>
