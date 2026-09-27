<script lang="ts">
	import { KeyRound, ArrowRight, LoaderCircle } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { signIn, signUp, isCancel } from '$lib/auth';
	import HeroArt from '$lib/components/app/hero-art.svelte';
	import Logo from '$lib/components/app/logo.svelte';

	let { data } = $props();

	let mode = $state<'signin' | 'signup'>(data.needsSetup || data.invite ? 'signup' : 'signin');
	let name = $state('');
	let busy = $state<'' | 'signin' | 'signup'>('');
	let error = $state('');
	const next = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('next') ?? '/' : '/';
	const canSignUp = $derived(data.needsSetup || data.signupMode === 'open' || !!data.invite);

	function done() {
		// full navigation so the root layout starts Zero for the signed-in user
		location.href = next;
	}

	async function createAccount(e?: Event) {
		e?.preventDefault();
		if (!name.trim()) {
			error = 'Enter your name.';
			return;
		}
		error = '';
		busy = 'signup';
		try {
			await signUp(name.trim(), data.invite ?? undefined);
			done();
		} catch (err) {
			if (!isCancel(err)) error = (err as Error).message;
		} finally {
			busy = '';
		}
	}

	async function passkey() {
		error = '';
		busy = 'signin';
		try {
			await signIn();
			done();
		} catch (err) {
			if (!isCancel(err)) error = (err as Error).message;
		} finally {
			busy = '';
		}
	}

</script>

<svelte:head><title>{mode === 'signup' ? 'Create account' : 'Sign in'} · Parasocial</title></svelte:head>

<main class="relative grid min-h-dvh place-items-center overflow-hidden bg-canvas px-4">
	<HeroArt class="pointer-events-none absolute inset-0" />
	<div
		class="animate-enter relative w-full max-w-[360px] rounded-dialog border border-line-subtle bg-panel/92 p-6 shadow-dialog backdrop-blur-xl [--ps-enter-scale:0.97] [--ps-enter-y:10px]"
		data-testid="signin-card"
	>
		<div class="mb-5 flex items-center gap-2">
			<Logo />
			<span class="text-title font-heading font-medium">Parasocial</span>
		</div>

		{#key mode}<div class="animate-[ps-tab-in_var(--duration-base)_var(--ease-out)]">
		{#if mode === 'signup'}
			<h1 class="text-heading">{data.needsSetup ? 'Set up this instance' : 'Create your account'}</h1>
			{#if data.needsSetup}
				<p class="mt-1 text-body text-fg-secondary">The first account becomes the admin.</p>
			{/if}
			<form class="mt-5 flex flex-col gap-3" onsubmit={createAccount}>
				<label class="flex flex-col gap-1.5">
					<span class="text-label text-fg-secondary">Name</span>
					<Input bind:value={name} placeholder="Ada Lovelace" autocomplete="name" autofocus maxlength={80} data-testid="name" />
				</label>
				<Button variant="primary" size="lg" type="submit" disabled={!!busy} class="w-full justify-center" data-testid="create-account">
					{#if busy === 'signup'}<LoaderCircle class="animate-spin" size={14} />{/if}
					Create account with passkey
				</Button>
			</form>
			<p class="mt-4 rounded-md bg-hover px-3 py-2 text-label text-fg-secondary">
				Your passkey is the only way to sign in. Save it to a synced keychain.
			</p>
			{#if !data.needsSetup}
				<div class="mt-4 text-center text-ui text-fg-secondary">
					Have an account? <button class="focus-ring rounded-xs font-medium text-accent hover:underline" onclick={() => ((mode = 'signin'), (error = ''))}>Sign in</button>
				</div>
			{/if}
		{:else}
			<h1 class="text-heading">Welcome back</h1>
			<div class="mt-5 flex flex-col gap-3">
				<Button variant="primary" size="lg" onclick={passkey} disabled={!!busy} class="w-full justify-center" data-testid="signin-passkey">
					{#if busy === 'signin'}<LoaderCircle class="animate-spin" size={14} />{:else}<KeyRound size={14} />{/if}
					Sign in with passkey
				</Button>
			</div>
			{#if canSignUp}
				<div class="mt-4 text-center text-ui text-fg-secondary">
					New here? <button class="focus-ring rounded-xs font-medium text-accent hover:underline" onclick={() => ((mode = 'signup'), (error = ''))} data-testid="to-signup">Create an account <ArrowRight class="inline" size={12} /></button>
				</div>
			{:else}
				<p class="mt-4 text-center text-label text-fg-tertiary">Sign-up is by invite only.</p>
			{/if}
		{/if}
		</div>{/key}

		{#if error}
			<p class="mt-3 animate-[ps-tab-in_var(--duration-fast)_var(--ease-out)] text-ui text-error" role="alert" data-testid="auth-error">{error}</p>
		{/if}
	</div>
</main>
