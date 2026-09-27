<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import { KeyRound, Plus, Trash2, Bot, Copy, Link } from '@lucide/svelte';
	import { Button, IconButton } from '$lib/components/ui/button';
	import { SegmentedControl } from '$lib/components/ui/segmented-control';
	import { toast } from '$lib/components/ui/toast';
	import AppHeader from '$lib/components/app/app-header.svelte';
	import { addPasskey, isCancel } from '$lib/auth';
	import { relativeTime } from '$lib/format';

	let { data } = $props();
	type Passkey = { id: string; name: string | null; synced: boolean; createdAt: string; lastUsedAt: string | null };
	let passkeys = $state.raw<Passkey[]>([]);
	let signupMode = $state<'open' | 'invite'>('open');
	let invites = $state.raw<{ token_hash?: string; expires_at?: string; used_at?: string | null }[]>([]);
	let inviteURL = $state('');

	async function api(path: string, body?: unknown) {
		const res = await fetch(`/api/auth/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
		const j = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(j.message ?? 'Something went wrong. Try again.');
		return j;
	}
	async function refresh() {
		passkeys = (await api('passkeys')).passkeys;
		if (data.user?.isAdmin) {
			signupMode = (await api('admin/settings')).signupMode;
			invites = (await api('admin/invites')).invites ?? [];
		}
	}
	onMount(refresh);

	async function add() {
		try {
			await addPasskey();
			toast.success('Passkey added');
			refresh();
		} catch (e) {
			if (!isCancel(e)) toast.error((e as Error).message);
		}
	}
	async function remove(id: string) {
		if (passkeys.length <= 1) return toast.error("You can't remove your only passkey");
		await api('passkeys/delete', { id });
		refresh();
	}
	async function setMode(m: string) {
		signupMode = (await api('admin/settings', { signupMode: m })).signupMode;
	}
	async function invite() {
		const r = await api('admin/invites', { ttlDays: 7 });
		inviteURL = r.url;
		await navigator.clipboard.writeText(r.url).catch(() => {});
		toast('Invite link copied');
		refresh();
	}
	const section = 'rounded-panel border border-line-subtle bg-panel';
</script>

<svelte:head><title>Settings · Parasocial</title></svelte:head>

<div class="flex min-h-dvh flex-col bg-canvas">
	<AppHeader user={data.user} title="Settings" />
	<main class="mx-auto flex w-full max-w-[640px] flex-col gap-6 px-6 py-8">
		<section class={section} data-testid="passkeys">
			<header class="flex h-12 items-center gap-2 border-b border-line-subtle px-4">
				<KeyRound size={16} class="text-fg-secondary" /><h2 class="text-body font-semibold">Passkeys</h2>
				<Button size="sm" class="ml-auto" onclick={add}><Plus size={14} /> Add passkey</Button>
			</header>
			<ul class="divide-y divide-line-subtle">
				{#each passkeys as p (p.id)}
					<li class="flex h-12 items-center gap-3 px-4 text-ui">
						<span class="font-medium">{p.name ?? 'Passkey'}</span>
						<span class="text-label text-fg-tertiary">{p.synced ? 'Synced' : 'This device only'} · added {relativeTime(new Date(p.createdAt).getTime())}</span>
						<IconButton label="Remove passkey" size="sm" class="ml-auto" onclick={() => remove(p.id)} disabled={passkeys.length <= 1}><Trash2 /></IconButton>
					</li>
				{/each}
			</ul>
			{#if passkeys.length === 1}
				<p class="border-t border-line-subtle px-4 py-3 text-label text-warning">Add a backup passkey in case you lose this one.</p>
			{/if}
		</section>

		<section class={section} data-testid="connected-agents">
			<header class="flex h-12 items-center gap-2 border-b border-line-subtle px-4">
				<Bot size={16} class="text-fg-secondary" /><h2 class="text-body font-semibold">Connected agents</h2>
			</header>
			<ul class="divide-y divide-line-subtle">
				{#each data.agents as a (a.id)}
					<li class="flex h-12 items-center gap-3 px-4 text-ui">
						<span class="font-medium">{a.name}</span>
						<span class="text-label text-fg-tertiary">connected {relativeTime(a.connectedAt)}</span>
						<form method="POST" action="?/revoke" use:enhance class="ml-auto"><input type="hidden" name="client" value={a.id} /><Button size="sm" variant="ghost" type="submit">Revoke</Button></form>
					</li>
				{:else}
					<li class="px-4 py-4 text-ui text-fg-secondary">No agents connected.</li>
				{/each}
			</ul>
		</section>

		{#if data.user?.isAdmin}
			<section class={section} data-testid="admin">
				<header class="flex h-12 items-center gap-2 border-b border-line-subtle px-4"><h2 class="text-body font-semibold">Instance</h2></header>
				<div class="flex flex-col gap-4 p-4">
					<div class="flex items-center gap-3 text-ui">
						<span class="w-28 text-fg-secondary">Sign-up</span>
						<SegmentedControl value={signupMode} items={[{ value: 'open', text: 'Open' }, { value: 'invite', text: 'Invite only' }]} onValueChange={setMode} class="w-48" />
					</div>
					{#if signupMode === 'invite'}
						<div class="flex items-center gap-3 text-ui">
							<span class="w-28 text-fg-secondary">Invites</span>
							<Button size="sm" onclick={invite}><Link size={14} /> Create invite link</Button>
						</div>
						{#if inviteURL}
							<div class="flex items-center gap-1 rounded-control bg-input pl-2.5"><code class="min-w-0 flex-1 truncate font-mono text-label">{inviteURL}</code><IconButton label="Copy" size="sm" onclick={() => navigator.clipboard.writeText(inviteURL)}><Copy /></IconButton></div>
						{/if}
					{/if}
				</div>
			</section>
		{/if}
	</main>
</div>
