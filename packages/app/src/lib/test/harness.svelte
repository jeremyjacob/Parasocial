<script lang="ts">
	// Renders a component inside the providers the app shell normally supplies (+layout.svelte).
	import { Tooltip } from 'bits-ui';
	import type { Component } from 'svelte';

	let { component: C, props = {} }: { component: Component<any>; props?: Record<string, unknown> } = $props();
</script>

<Tooltip.Provider>
	<C {...props} />
</Tooltip.Provider>
