<script lang="ts">
	// The Parasocial mark ("Face" concept): a solid with its top face lifted and picked out in the
	// accent — the moment you select a face to leave a note on it.
	import LogoFace from './logo-face.svelte';
	let { size = 28 }: { size?: number } = $props();
</script>

<LogoFace {size} />
