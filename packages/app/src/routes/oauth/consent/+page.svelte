<script lang="ts">
	import { Bot, ShieldCheck } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import Logo from '$lib/components/app/logo.svelte';
	let { data } = $props();
</script>

<svelte:head><title>Connect {data.clientName ?? 'agent'} · Parasocial</title></svelte:head>

<main class="grid min-h-dvh place-items-center bg-canvas px-4">
	<div class="w-full max-w-[380px] rounded-dialog border border-line-subtle bg-panel p-6 shadow-dialog" data-testid="consent">
		<div class="mb-5 flex items-center gap-2"><Logo /><span class="text-title font-heading font-medium">Parasocial</span></div>
		{#if data.error}
			<h1 class="text-heading">Can't connect</h1>
			<p class="mt-2 text-body text-fg-secondary">{data.error}</p>
		{:else}
			<div class="mb-4 flex items-center gap-3 rounded-md bg-hover p-3">
				<span class="grid size-9 place-items-center rounded-md bg-agent text-white"><Bot size={18} /></span>
				<div class="min-w-0">
					<div class="truncate text-body font-semibold">{data.clientName}</div>
					<div class="truncate text-label text-fg-secondary">{data.redirectHost}</div>
				</div>
			</div>
			<h1 class="text-title">Allow {data.clientName} to work on your documents?</h1>
			<ul class="mt-3 flex flex-col gap-1.5 text-ui text-fg-secondary">
				<li>Read your documents, notes and scripts</li>
				<li>Edit scripts and params, reply to notes</li>
			</ul>
			<p class="mt-3 flex items-center gap-1.5 text-label text-fg-tertiary"><ShieldCheck size={12} /> You can revoke access anytime in Settings.</p>
			<form method="POST" class="mt-5 flex justify-end gap-2">
				<Button variant="ghost" type="submit" name="decision" value="deny" data-testid="deny">Deny</Button>
				<Button variant="primary" type="submit" name="decision" value="approve" data-testid="approve">Allow</Button>
			</form>
		{/if}
	</div>
</main>
