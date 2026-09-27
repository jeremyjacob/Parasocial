<script lang="ts">
	import { assets } from '$app/paths';
	let { size = 28 }: { size?: number } = $props();
</script>

<img src="{assets}/parasocial-icon.png" width={size} height={size} alt="" class="shrink-0" />
