<script lang="ts">
	import { ArrowRight } from '@lucide/svelte';
</script>

<svelte:head><title>Parasocial</title></svelte:head>

<main class="grid min-h-dvh place-items-center bg-canvas">
	<div class="flex flex-col items-center gap-3 text-center">
		<div class="text-title font-semibold">Parasocial</div>
		<p class="text-ui text-fg-secondary">The workspace is not built yet.</p>
		<a
			href="/design"
			class="focus-ring inline-flex h-7 items-center gap-1.5 rounded-control bg-control px-3 text-ui font-medium shadow-control transition-colors-fast hover:bg-hover"
		>
			Design system <ArrowRight size={14} strokeWidth={1.5} />
		</a>
	</div>
</main>
