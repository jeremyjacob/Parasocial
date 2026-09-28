<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { goto, invalidateAll } from '$app/navigation';
	import { Plus, Upload, FileBox, LoaderCircle, Pencil, Trash2, Bot } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { Dialog, ConfirmDialog } from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { ContextMenu, type MenuEntry } from '$lib/components/ui/menu';
	import { toast } from '$lib/components/ui/toast';
	import { useQuery, getZero } from '@parasocial/sync/svelte';
	import { queries, mutators, type ParasocialZero } from '@parasocial/sync';
	import AppHeader from '$lib/components/app/app-header.svelte';
	import HeroArt from '$lib/components/app/hero-art.svelte';
	import AgentSetup from '$lib/components/app/agent-setup.svelte';
	import { configureEngine, warmEngine } from '$lib/engine';
	import { newID } from '$lib/zero';
	import { relativeTime } from '$lib/format';
	import ConnectAgentDialog from '$lib/workspace/ConnectAgentDialog.svelte';

	let { data } = $props();
	configureEngine(data.engineURL);

	// Zero is browser-only: SSR renders the server-loaded list, then the live query takes over
	const zero = browser ? getZero<ParasocialZero>() : (null as unknown as ParasocialZero);
	const live = browser ? useQuery(() => queries.documents.mine()) : { data: undefined as unknown, status: 'unknown' as const };
	const docs = $derived(
		live.status === 'complete' || (live.data && (live.data as unknown[]).length)
			? (live.data as any[]).map((d) => ({ id: d.id, name: d.name, updatedAt: d.updatedAt, headVersion: d.headVersion, thumb: (d.thumbLight as string | null) ?? undefined, studios: undefined as number | undefined }))
			: data.docs
	);

	// rendered thumbnails (signed blob URLs): from SSR, refetched when a document's thumbnail changes
	let thumbs = $state.raw<Record<string, { light: string; dark: string }>>(data.thumbs);
	let thumbKey = '';
	$effect(() => {
		const key = docs.map((d) => `${d.id}:${d.thumb ?? ''}`).join();
		const stale = docs.some((d) => d.thumb && !thumbs[d.id]?.light.includes(d.thumb));
		if (key === thumbKey || !stale) return void (thumbKey = key);
		thumbKey = key;
		fetch('/api/blobs/thumbs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documentIDs: docs.map((d) => d.id) }) })
			.then((r) => (r.ok ? r.json() : null))
			.then((b) => b && (thumbs = b.urls));
	});

	type Example = { slug: string; name: string; units: string; configurations: any[]; scripts: { path: string; content: string }[] };
	let examples = $state.raw<Example[]>([]);
	let creating = $state(false);
	let connectOpen = $state(false);
	const agentReady = $derived(data.agentConfigured || data.mcpConnected);
	let newOpen = $state(false);
	let newName = $state('');
	let importing = $state('');

	onMount(async () => {
		const res = await fetch('/api/examples');
		if (res.ok) examples = await res.json();
	});

	async function create(e?: Event) {
		e?.preventDefault();
		const name = newName.trim() || 'Untitled';
		creating = true;
		const id = newID();
		const r = zero.mutate(mutators.document.create({ id, name }));
		await r.client;
		creating = false;
		newOpen = false;
		newName = '';
		goto(`/d/${id}`);
	}

	async function openExample(ex: Example) {
		importing = ex.slug;
		const id = newID();
		try {
			const r = zero.mutate(
				mutators.document.import({ id, name: ex.name, units: ex.units, scripts: ex.scripts, configurations: ex.configurations })
			);
			await r.client;
			goto(`/d/${id}`);
		} catch (err) {
			toast.error?.(`Couldn't open ${ex.name}. Try again.`);
		} finally {
			importing = '';
		}
	}

	// ---- Figma-style selection (documents and examples; one list at a time) ----
	type List = 'docs' | 'examples';
	let selList = $state<List>('docs');
	let selected = $state(new Set<string>());
	let anchor = -1;
	const keysOf = (list: List) => (list === 'docs' ? docs.map((d) => d.id) : examples.map((ex) => ex.slug));
	const isSelected = (list: List, key: string) => selList === list && selected.has(key);
	function select(list: List, i: number, e: MouseEvent) {
		const keys = keysOf(list);
		const key = keys[i];
		const next = new Set(selList === list ? selected : []);
		selList = list;
		if (e.shiftKey && anchor >= 0) {
			const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
			for (let k = a; k <= b; k++) next.add(keys[k]);
		} else if (e.metaKey || e.ctrlKey) {
			next.has(key) ? next.delete(key) : next.add(key);
			anchor = i;
		} else {
			next.clear();
			next.add(key);
			anchor = i;
		}
		selected = next;
	}
	// right-click on an unselected card selects just it, so the menu acts on what's highlighted
	function selectForMenu(list: List, i: number) {
		const key = keysOf(list)[i];
		if (isSelected(list, key)) return;
		selList = list;
		selected = new Set([key]);
		anchor = i;
	}
	function open(list: List, key: string) {
		if (list === 'docs') return goto(`/d/${key}`);
		const ex = examples.find((x) => x.slug === key);
		if (ex && !importing) openExample(ex);
	}
	let deleteOpen = $state(false);
	let deleteIDs = $state<string[]>([]);
	function deleteDocs(ids: string[]) {
		if (!ids.length) return;
		deleteIDs = [...ids];
		deleteOpen = true;
	}
	function confirmDeleteDocs() {
		for (const id of deleteIDs) zero.mutate(mutators.document.delete({ id }));
		selected = new Set();
	}
	function onGridKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && selected.size === 1) open(selList, [...selected][0]);
		if (e.key === 'Escape') selected = new Set();
		if ((e.key === 'Backspace' || e.key === 'Delete') && selList === 'docs') deleteDocs([...selected]);
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
			e.preventDefault();
			selected = new Set(keysOf(selList));
		}
	}

	// ---- context menus ----
	let renameOpen = $state(false);
	let renameID = $state('');
	let renameName = $state('');
	function startRename(id: string) {
		renameID = id;
		renameName = docs.find((d) => d.id === id)?.name ?? '';
		renameOpen = true;
	}
	function rename(e?: Event) {
		e?.preventDefault();
		const name = renameName.trim();
		if (name) zero.mutate(mutators.document.rename({ id: renameID, name }));
		renameOpen = false;
	}
	function docMenu(id: string): MenuEntry[] {
		const ids = isSelected('docs', id) ? [...selected] : [id];
		return [
			{ label: 'Rename…', icon: Pencil, disabled: ids.length > 1, onSelect: () => startRename(id) },
			{ type: 'separator' },
			{ label: ids.length > 1 ? `Delete ${ids.length} documents` : 'Delete', icon: Trash2, destructive: true, onSelect: () => deleteDocs(ids) }
		];
	}

	async function importZip() {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.zip,application/zip';
		input.onchange = async () => {
			const f = input.files?.[0];
			if (!f) return;
			const res = await fetch('/api/documents/import', { method: 'POST', body: f, headers: { 'Content-Type': 'application/zip' } });
			const body = await res.json().catch(() => ({}));
			if (!res.ok) return toast.error?.(body.message ?? "Couldn't import that file");
			goto(`/d/${body.id ?? body.documentID}`);
		};
		input.click();
	}
</script>

<!-- coming back from the terminal or the sign-in tab: recheck, so the setup card goes once an agent has signed in -->
<svelte:window onfocus={() => !agentReady && invalidateAll()} onclick={(e) => { if (!(e.target as Element)?.closest?.('[role=option], [role=menu]')) selected = new Set(); }} />

<svelte:head><title>Documents · Parasocial</title></svelte:head>

<div class="flex min-h-dvh flex-col bg-canvas">
	<AppHeader user={data.user}>
		{#snippet actions()}
			<Button variant="ghost" onclick={() => (connectOpen = true)} data-testid="connect-agent-button"><Bot size={14} /> Connect agent</Button>
			<Button variant="ghost" onclick={importZip} data-testid="import-zip"><Upload size={14} /> Import</Button>
			<Button variant="primary" onclick={() => (newOpen = true)} data-testid="new-document"><Plus size={14} /> New document</Button>
		{/snippet}
	</AppHeader>

	<main class="mx-auto w-full max-w-[1120px] flex-1 px-6 py-8">
		{#if docs.length === 0}
			<section class="flex flex-col items-center pt-6 text-center" data-testid="empty-documents">
				<HeroArt name="hero" fit="contain" class="relative h-[300px] w-full max-w-[640px]" />
				<h1 class="mt-2 text-heading">Create your first document</h1>
				{#if agentReady}
					<Button variant="primary" size="lg" class="mt-5" onclick={() => (newOpen = true)}><Plus size={14} /> New document</Button>
				{:else}
					<AgentSetup class="mt-6 w-full max-w-[720px]" onConnect={() => (connectOpen = true)} />
				{/if}
			</section>
		{:else}
			{#if !agentReady}<AgentSetup class="mb-8" onConnect={() => (connectOpen = true)} />{/if}
			<h1 class="mb-4 text-title">Documents</h1>
			<!-- Figma-style grid: click selects (⌘ toggles, ⇧ extends), double-click opens -->
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<ul
				class="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4"
				role="listbox"
				aria-multiselectable="true"
				aria-label="Documents"
				tabindex="-1"
				data-testid="document-list"
				onkeydown={onGridKey}
			>
				{#each docs as d, i (d.id)}
					<li
						role="option"
						aria-selected={isSelected('docs', d.id)}
						tabindex="0"
						class="group overflow-hidden rounded-panel border bg-panel outline-none select-none {isSelected('docs', d.id) ? 'border-accent ring-1 ring-accent' : 'border-line'}"
						onpointerenter={warmEngine}
						onfocus={warmEngine}
						onclick={(e) => select('docs', i, e)}
						oncontextmenu={() => selectForMenu('docs', i)}
						ondblclick={() => open('docs', d.id)}
						data-testid="document-card"
					>
						<ContextMenu items={docMenu(d.id)} class="flex flex-col">
							<div class="relative grid h-40 place-items-center bg-canvas">
								{#if thumbs[d.id]}
									<img src={thumbs[d.id].light} alt="" class="thumb-light absolute inset-0 size-full object-contain" loading="lazy" data-testid="document-thumb" />
									<img src={thumbs[d.id].dark} alt="" class="thumb-dark absolute inset-0 size-full object-contain" loading="lazy" />
								{:else}
									<FileBox size={28} strokeWidth={1.25} class="text-fg-tertiary opacity-50" />
								{/if}
							</div>
							<div class="flex items-center gap-2.5 border-t border-line-subtle px-3 py-2.5">
								<span class="grid size-6 shrink-0 place-items-center rounded-control bg-accent text-fg-on-accent"><FileBox size={13} /></span>
								<span class="flex min-w-0 flex-col">
									<span class="truncate text-ui font-medium">{d.name}</span>
									<span class="truncate text-label text-fg-tertiary">Edited {relativeTime(d.updatedAt)}</span>
								</span>
							</div>
						</ContextMenu>
					</li>
				{/each}
			</ul>
		{/if}

		{#if examples.length}
			<section class="mt-12">
				<h2 class="mb-4 text-section">Examples</h2>
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<ul
					class="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3"
					role="listbox"
					aria-multiselectable="true"
					aria-label="Examples"
					tabindex="-1"
					data-testid="examples"
					onkeydown={onGridKey}
				>
					{#each examples as ex, i (ex.slug)}
						{@const studios = ex.scripts.filter((s) => s.path.startsWith('studios/')).length}
						<li
							role="option"
							aria-selected={isSelected('examples', ex.slug)}
							aria-disabled={!!importing}
							tabindex="0"
							class="group overflow-hidden rounded-panel border bg-panel outline-none select-none {isSelected('examples', ex.slug) ? 'border-accent ring-1 ring-accent' : 'border-line'} {importing ? 'opacity-60' : ''}"
							onpointerenter={warmEngine}
							onfocus={warmEngine}
							onclick={(e) => select('examples', i, e)}
							ondblclick={() => open('examples', ex.slug)}
							data-testid="example-{ex.slug}"
						>
							<div class="relative h-24 bg-canvas"><HeroArt name={ex.slug} fit="contain" class="absolute inset-2" /></div>
							<div class="flex h-10 items-center gap-1.5 border-t border-line-subtle px-3 text-ui font-medium">
								{#if importing === ex.slug}<LoaderCircle size={12} class="animate-spin" />{/if}
								{ex.name}
								<span class="ml-auto text-label font-normal text-fg-tertiary">{studios} studio{studios === 1 ? '' : 's'}</span>
							</div>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	</main>
</div>

<ConnectAgentDialog bind:open={connectOpen} />

<ConfirmDialog
	bind:open={deleteOpen}
	title={`Delete ${deleteIDs.length} document${deleteIDs.length === 1 ? '' : 's'}?`}
	description="This can't be undone."
	onconfirm={confirmDeleteDocs}
/>

<Dialog bind:open={newOpen} title="New document">
	<form id="new-doc" onsubmit={create} class="flex flex-col gap-1.5">
		<span class="text-label text-fg-secondary">Name</span>
		<Input bind:value={newName} placeholder="Untitled" data-testid="new-document-name" />
	</form>
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (newOpen = false)}>Cancel</Button>
		<Button variant="primary" type="submit" form="new-doc" disabled={creating} data-testid="create-document">Create</Button>
	{/snippet}
</Dialog>

<Dialog bind:open={renameOpen} title="Rename document">
	<form id="rename-doc" onsubmit={rename} class="flex flex-col gap-1.5">
		<span class="text-label text-fg-secondary">Name</span>
		<Input bind:value={renameName} data-testid="rename-document-name" />
	</form>
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (renameOpen = false)}>Cancel</Button>
		<Button variant="primary" type="submit" form="rename-doc" disabled={!renameName.trim()} data-testid="rename-document">Rename</Button>
	{/snippet}
</Dialog>

<style>
	/* rendered per theme; only the one for the app's theme shows (lazy, so the other isn't fetched) */
	.thumb-dark {
		display: none;
	}
	:global([data-theme='dark']) .thumb-dark {
		display: block;
	}
	:global([data-theme='dark']) .thumb-light {
		display: none;
	}
</style>
