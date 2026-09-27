<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { Tooltip } from 'bits-ui';
	import { theme } from '$lib/theme.svelte';
	import { Toaster } from '$lib/components/ui/toast';

	import { setLucideProps } from '@lucide/svelte';

	let { children } = $props();

	// One icon grammar everywhere: 16px, 1.5 stroke. Override per-icon only with reason.
	setLucideProps({ size: 16, strokeWidth: 1.5 });

	onMount(() => theme.start());
</script>

<!--
	App shell. Owns: global CSS/tokens, theme controller, the shared tooltip provider
	(Figma-style: 500 ms first delay, instant while moving between triggers) and the toaster.
	Workspace routes build their own chrome inside this.
-->
<Tooltip.Provider delayDuration={500} skipDelayDuration={300} disableHoverableContent>
	{@render children()}
	<Toaster />
</Tooltip.Provider>
