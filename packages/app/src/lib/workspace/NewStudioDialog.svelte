<script lang="ts">
	import { FilePlus2, Sparkles } from '@lucide/svelte';
	import { Dialog } from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Kbd } from '$lib/components/ui/kbd';
	import { page } from '$app/state';
	import { invalidateAll } from '$app/navigation';
	import AgentSetupDialog from './AgentSetupDialog.svelte';

	// Shown for "Add a studio": describe the part and hand it over, or start from the blank template.
	// With no agent yet, Build opens the setup dialog on top and carries on once a key is saved.
	let { open = $bindable(false), onPrompt, onBlank, onConnect }: { open?: boolean; onPrompt: (text: string) => Promise<boolean>; onBlank: () => Promise<void>; onConnect: () => void } = $props();
	let setupOpen = $state(false);
	const hasAgent = () => !!(page.data.agentConfigured || page.data.mcpConnected);

	const ideas = [
		{ label: 'Wall hook', text: 'A wall hook for a coat: 60 mm tall, with two countersunk holes for M4 screws.' },
		{ label: 'Control knob', text: 'A 30 mm control knob with a knurled grip that fits a 6 mm D-shaft.' },
		{ label: 'Pi enclosure', text: 'A two-part enclosure for a Raspberry Pi 4 with vents in the lid and cutouts for the ports.' },
		{ label: 'Cable clip', text: 'A clip that holds three 5 mm cables side by side and screws under a desk.' }
	];

	let text = $state('');
	let busy = $state<'' | 'prompt' | 'blank'>('');
	let field = $state<HTMLTextAreaElement | null>(null);
	const ready = $derived(!!text.trim() && !busy);

	// each open starts fresh
	$effect(() => {
		if (open) (text = ''), (busy = '');
	});

	async function submit(e?: Event) {
		e?.preventDefault();
		if (!ready) return;
		if (!hasAgent()) {
			// maybe they connected one in another tab since the page loaded
			await invalidateAll();
			if (!hasAgent()) return void (setupOpen = true);
		}
		busy = 'prompt';
		const ok = await onPrompt(text.trim());
		busy = '';
		if (ok) open = false;
	}

	async function blank() {
		if (busy) return;
		busy = 'blank';
		await onBlank();
		busy = '';
		open = false;
	}

	function onkey(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) submit(e);
	}

	function useIdea(idea: string) {
		text = idea;
		field?.focus();
		field?.setSelectionRange(idea.length, idea.length);
	}
</script>

<Dialog bind:open title="New studio" description="Describe the part and the agent will build it in a new studio." class="w-[min(520px,calc(100vw-32px))]">
	<form id="new-studio" onsubmit={submit} class="flex flex-col gap-3" data-testid="new-studio">
		<div class="field h-auto flex-col items-stretch gap-1 px-3 pt-2.5 pb-2" data-disabled={busy ? '' : undefined}>
			<textarea
				bind:this={field}
				bind:value={text}
				rows="3"
				placeholder="A mounting bracket for a 25 mm pipe…"
				onkeydown={onkey}
				aria-label="What should the agent make?"
				class="field-sizing-content max-h-52 min-h-[4.5rem] w-full resize-none bg-transparent text-body text-fg outline-none placeholder:text-fg-tertiary"
				data-testid="new-studio-prompt"
			></textarea>
			<div class="flex h-5 items-center justify-end gap-3 text-caption text-fg-tertiary" aria-hidden="true">
				<span class="flex items-center gap-1"><Kbd keys={['mod', 'enter']} /> build</span>
			</div>
		</div>
		<div class="flex flex-wrap items-center gap-1.5" aria-label="Ideas">
			{#each ideas as idea (idea.label)}
				<button
					type="button"
					disabled={!!busy}
					onclick={() => useIdea(idea.text)}
					class="focus-ring h-6 rounded-full px-2.5 text-label text-fg-secondary shadow-[inset_0_0_0_1px_var(--border-default)] transition-colors-fast hover:bg-hover hover:text-fg hover:shadow-[inset_0_0_0_1px_var(--border-strong)] active:bg-active disabled:opacity-40"
					>{idea.label}</button
				>
			{/each}
		</div>
	</form>
	<AgentSetupDialog bind:open={setupOpen} onSaved={() => submit()} {onConnect} />
	{#snippet footer()}
		<Button variant="ghost" class="mr-auto -ml-2 text-fg-secondary" onclick={blank} loading={busy === 'blank'} disabled={!!busy} data-testid="new-studio-blank">{#if busy !== 'blank'}<FilePlus2 size={14} />{/if} Start blank</Button>
		<Button variant="ghost" onclick={() => (open = false)} disabled={!!busy}>Cancel</Button>
		<Button variant="primary" type="submit" form="new-studio" disabled={!ready} loading={busy === 'prompt'} data-testid="new-studio-submit">{#if busy !== 'prompt'}<Sparkles size={14} />{/if} Build with agent</Button>
	{/snippet}
</Dialog>
