<script lang="ts">
	// Link sharing: one view-only link per document (/s/:token). Anyone holding it sees the model,
	// its code and configurations, signed in or not; notes, history and members stay private.
	import { Copy, Check, RefreshCw } from '@lucide/svelte';
	import { mutators, newShareToken } from '@parasocial/sync';
	import { Dialog } from '$lib/components/ui/dialog';
	import { Button, IconButton } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch';
	import { toast } from '$lib/components/ui/toast';
	import type { WorkspaceState } from './state.svelte';

	let { open = $bindable(false), ws }: { open?: boolean; ws: WorkspaceState } = $props();
	const token = $derived(ws.doc?.shareToken ?? null);
	const url = $derived(token && typeof location !== 'undefined' ? `${location.origin}/s/${token}` : '');
	let copied = $state(false);

	// not an edit: straight to Zero, outside undo
	const setToken = (t: string | null) => ws.zero.mutate(mutators.document.setShareToken({ id: ws.documentID, token: t })).client;

	async function toggle(on: boolean) {
		try {
			await setToken(on ? newShareToken() : null);
			if (on) await copy();
		} catch (e) {
			toast.error((e as Error).message || "Couldn't change link sharing. Try again.");
		}
	}

	async function reset() {
		try {
			await setToken(newShareToken());
			toast('New link made. The old one no longer works.');
		} catch (e) {
			toast.error((e as Error).message || "Couldn't make a new link. Try again.");
		}
	}

	async function copy() {
		if (!url) return;
		try {
			await navigator.clipboard.writeText(url);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			toast.error('Could not copy to the clipboard. Select and copy the link instead.');
		}
	}
</script>

<Dialog bind:open title="Share" class="max-w-[440px]">
	<div class="flex flex-col gap-4" data-testid="share-dialog">
		<div class="flex items-start gap-3">
			<div class="flex min-w-0 flex-1 flex-col gap-0.5">
				<label for="share-link" class="text-ui font-medium">Anyone with the link can view</label>
				<p class="text-label text-fg-secondary">No account needed. They see the model, its code and configurations, and can try param values without saving. Notes and history stay private.</p>
			</div>
			<Switch id="share-link" checked={!!token} onCheckedChange={toggle} class="h-5" />
		</div>
		{#if token}
			<div class="flex flex-col gap-1.5">
				<div class="flex items-center gap-1 rounded-control bg-input pl-2.5">
					<code class="min-w-0 flex-1 truncate font-mono text-label" data-testid="share-url">{url}</code>
					<IconButton label="Copy link" size="sm" onclick={copy} data-testid="copy-share-url">{#if copied}<Check />{:else}<Copy />{/if}</IconButton>
				</div>
				<Button size="sm" variant="ghost" class="self-start text-fg-secondary" onclick={reset} data-testid="reset-share-url"><RefreshCw size={14} /> Make a new link</Button>
			</div>
		{/if}
	</div>
</Dialog>
