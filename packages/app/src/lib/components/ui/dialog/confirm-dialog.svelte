<script lang="ts">
	import Dialog from './dialog.svelte';
	import { Button } from '$lib/components/ui/button';

	let { open = $bindable(false), title, description, onconfirm }: {
		open?: boolean;
		title: string;
		description: string;
		onconfirm: () => void | Promise<void>;
	} = $props();
</script>

<Dialog bind:open {title} {description}>
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
		<Button variant="destructive" onclick={() => { open = false; onconfirm(); }}>Delete</Button>
	{/snippet}
</Dialog>
