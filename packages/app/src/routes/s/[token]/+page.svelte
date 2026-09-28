<script lang="ts">
	import { setZero, getZero } from '@parasocial/sync/svelte';
	import type { ParasocialZero } from '@parasocial/sync';
	import { Button } from '$lib/components/ui/button';
	import Logo from '$lib/components/app/logo.svelte';
	import { configureEngine } from '$lib/engine';
	import { zeroFor } from '$lib/zero';
	import Workspace from '$lib/workspace/Workspace.svelte';

	let { data } = $props();
	configureEngine(data.engineURL);
	// signed in: the layout's client (queries run as this user, the link grants the rest); signed out: an anonymous one
	const zero = data.user ? getZero<ParasocialZero>() : setZero(zeroFor(null));
</script>

<svelte:head>{#if !data.shared}<title>Link not found · Parasocial</title>{/if}</svelte:head>

{#if data.shared}
	{#key data.shared.id}
		<Workspace documentID={data.shared.id} {zero} user={data.user} share={data.share} />
	{/key}
{:else}
	<div class="grid h-dvh place-items-center bg-canvas">
		<div class="animate-enter flex flex-col items-center gap-3 text-center" data-testid="share-not-found">
			<Logo size={28} />
			<p class="text-title font-heading font-medium">This link doesn't work</p>
			<p class="max-w-80 text-ui text-fg-secondary">Link sharing may have been turned off, or the link was replaced with a new one. Ask for a new link.</p>
			{#if data.user}<Button href="/">All documents</Button>{:else}<Button href="/signin">Sign in</Button>{/if}
		</div>
	</div>
{/if}
