<script lang="ts">
	import { getZero } from '@parasocial/sync/svelte';
	import type { ParasocialZero } from '@parasocial/sync';
	import { configureEngine } from '$lib/engine';
	import Workspace from '$lib/workspace/Workspace.svelte';

	let { data } = $props();
	configureEngine(data.engineURL);
	const zero = getZero<ParasocialZero>();
</script>

{#key data.id}
	<Workspace documentID={data.id} {zero} user={data.user!} agentConfigured={data.agentConfigured} mcpConnected={data.mcpConnected} />
{/key}
