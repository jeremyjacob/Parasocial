<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { Plus, Upload, FileBox, LoaderCircle } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { Dialog } from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { toast } from '$lib/components/ui/toast';
	import { useQuery, getZero } from '@parasocial/sync/svelte';
	import { queries, mutators, type ParasocialZero } from '@parasocial/sync';
	import AppHeader from '$lib/components/app/app-header.svelte';
	import HeroArt from '$lib/components/app/hero-art.svelte';
	import { configureEngine, warmEngine } from '$lib/engine';
	import { newID } from '$lib/zero';
	import { relativeTime } from '$lib/format';

	let { data } = $props();
	configureEngine(data.engineURL);

	// Zero is browser-only: SSR renders the server-loaded list, then the live query takes over
	const zero = browser ? getZero<ParasocialZero>() : (null as unknown as ParasocialZero);
	const live = browser ? useQuery(() => queries.documents.mine()) : { data: undefined as unknown, status: 'unknown' as const };
	const docs = $derived(
		live.status === 'complete' || (live.data && (live.data as unknown[]).length)
			? (live.data as any[]).map((d) => ({ id: d.id, name: d.name, updatedAt: d.updatedAt, headVersion: d.headVersion, parts: undefined as number | undefined }))
			: data.docs
	);

	type Example = { slug: string; name: string; units: string; configurations: any[]; scripts: { path: string; content: string }[] };
	let examples = $state.raw<Example[]>([]);
	let creating = $state(false);
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

	// ---- Figma-style selection ----
	let selected = $state(new Set<string>());
	let anchor = -1;
	function selectDoc(id: string, i: number, e: MouseEvent) {
		const next = new Set(selected);
		if (e.shiftKey && anchor >= 0) {
			const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
			for (let k = a; k <= b; k++) next.add(docs[k].id);
		} else if (e.metaKey || e.ctrlKey) {
			next.has(id) ? next.delete(id) : next.add(id);
			anchor = i;
		} else {
			next.clear();
			next.add(id);
			anchor = i;
		}
		selected = next;
	}
	async function onGridKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && selected.size === 1) goto(`/d/${[...selected][0]}`);
		if (e.key === 'Escape') selected = new Set();
		if ((e.key === 'Backspace' || e.key === 'Delete') && selected.size) {
			if (!confirm(`Delete ${selected.size} document${selected.size === 1 ? '' : 's'}? This can't be undone.`)) return;
			for (const id of selected) zero.mutate(mutators.document.delete({ id }));
			selected = new Set();
		}
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
			e.preventDefault();
			selected = new Set(docs.map((d) => d.id));
		}
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

<svelte:window onclick={(e) => { if (!(e.target as Element)?.closest?.('[data-testid=document-card]')) selected = new Set(); }} />

<svelte:head><title>Documents · Parasocial</title></svelte:head>

<div class="flex min-h-dvh flex-col bg-canvas">
	<AppHeader user={data.user} title="Documents">
		{#snippet actions()}
			<Button variant="ghost" onclick={importZip} data-testid="import-zip"><Upload size={14} /> Import</Button>
			<Button variant="primary" onclick={() => (newOpen = true)} data-testid="new-document"><Plus size={14} /> New document</Button>
		{/snippet}
	</AppHeader>

	<main class="mx-auto w-full max-w-[1120px] flex-1 px-6 py-8">
		{#if docs.length === 0}
			<section class="flex flex-col items-center pt-6 text-center" data-testid="empty-documents">
				<HeroArt name="hero" fit="contain" class="relative h-[300px] w-full max-w-[640px]" />
				<h1 class="mt-2 text-heading font-semibold">Create your first document</h1>
				<Button variant="primary" size="lg" class="mt-5" onclick={() => (newOpen = true)}><Plus size={14} /> New document</Button>
			</section>
		{:else}
			<h1 class="mb-4 text-title font-semibold">Documents</h1>
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
						aria-selected={selected.has(d.id)}
						tabindex="0"
						class="group flex flex-col overflow-hidden rounded-panel border bg-panel outline-none select-none {selected.has(d.id) ? 'border-accent ring-1 ring-accent' : 'border-line-subtle hover:border-line'}"
						onpointerenter={warmEngine}
						onfocus={warmEngine}
						onclick={(e) => selectDoc(d.id, i, e)}
						ondblclick={() => goto(`/d/${d.id}`)}
						data-testid="document-card"
					>
						<div class="relative grid h-40 place-items-center bg-canvas">
							<HeroArt name="thumb" fit="contain" class="absolute inset-4" />
						</div>
						<div class="flex items-center gap-2.5 border-t border-line-subtle px-3 py-2.5">
							<span class="grid size-6 shrink-0 place-items-center rounded-control bg-accent text-fg-on-accent"><FileBox size={13} /></span>
							<span class="flex min-w-0 flex-col">
								<span class="truncate text-ui font-medium">{d.name}</span>
								<span class="truncate text-label text-fg-tertiary">Edited {relativeTime(d.updatedAt)}</span>
							</span>
						</div>
					</li>
				{/each}
			</ul>
		{/if}

		{#if examples.length}
			<section class="mt-12">
				<h2 class="mb-4 text-ui font-semibold">Examples</h2>
				<ul class="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3" data-testid="examples">
					{#each examples as ex (ex.slug)}
						<li>
							<button
								class="focus-ring group flex w-full flex-col overflow-hidden rounded-panel border border-line-subtle bg-panel text-left hover:border-line disabled:opacity-60"
								onpointerenter={warmEngine}
								onclick={() => openExample(ex)}
								disabled={!!importing}
								data-testid="example-{ex.slug}"
							>
								<div class="relative h-24 bg-canvas"><HeroArt name={ex.slug} fit="contain" class="absolute inset-2" /></div>
								<div class="flex h-10 items-center gap-1.5 border-t border-line-subtle px-3 text-ui font-medium">
									{#if importing === ex.slug}<LoaderCircle size={12} class="animate-spin" />{/if}
									{ex.name}
									<span class="ml-auto text-label font-normal text-fg-tertiary">{ex.scripts.filter((s) => s.path.startsWith('parts/')).length} part{ex.scripts.filter((s) => s.path.startsWith('parts/')).length === 1 ? '' : 's'}</span>
								</div>
							</button>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	</main>
</div>

<Dialog bind:open={newOpen} title="New document">
	<form id="new-doc" onsubmit={create} class="flex flex-col gap-1.5">
		<span class="text-label text-fg-secondary">Name</span>
		<Input bind:value={newName} placeholder="Untitled" autofocus data-testid="new-document-name" />
	</form>
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (newOpen = false)}>Cancel</Button>
		<Button variant="primary" type="submit" form="new-doc" disabled={creating} data-testid="create-document">Create</Button>
	{/snippet}
</Dialog>
