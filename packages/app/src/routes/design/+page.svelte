<script lang="ts">
	import { page } from '$app/state';
	import { Hexagon } from '@lucide/svelte';
	import { SegmentedControl } from '$lib/components/ui/segmented-control';
	import { ThemeToggle } from '$lib/components/ui/theme-toggle';
	import { theme } from '$lib/theme.svelte';
	import ThemePane from './ThemePane.svelte';
	import TokensShowcase from './TokensShowcase.svelte';
	import ComponentsShowcase from './ComponentsShowcase.svelte';
	import WorkspacePreview from './WorkspacePreview.svelte';

	// ?view=light|dark|split and ?only=workspace let the screenshot script frame things precisely.
	let view = $state<'split' | 'light' | 'dark'>(
		(page.url.searchParams.get('view') as 'split' | 'light' | 'dark' | null) ?? 'split'
	);
	const only = page.url.searchParams.get('only');
	const panes = $derived<('light' | 'dark')[]>(view === 'split' ? ['light', 'dark'] : [view]);

	const nav = [
		['color', 'Color'],
		['parts', 'Parts'],
		['type', 'Type'],
		['spacing', 'Spacing'],
		['elevation', 'Elevation'],
		['controls', 'Controls'],
		['overlays', 'Overlays'],
		['display', 'Display'],
		['panels', 'Panels'],
		['viewport', 'Viewport'],
		['states', 'Empty'],
		['notes', 'Notes'],
		['workspace', 'Workspace']
	];
</script>

<svelte:head><title>Design system · Parasocial</title></svelte:head>

<div class="min-h-dvh bg-app">
	<header
		data-design-header class="sticky top-0 z-40 flex h-12 items-center gap-4 border-b border-line-subtle bg-panel/85 px-4 backdrop-blur-md"
	>
		<div class="flex items-center gap-2">
			<span class="grid size-6 place-items-center rounded-md bg-fg text-panel"><Hexagon size={14} strokeWidth={2.25} /></span>
			<span class="text-ui font-heading font-medium">Parasocial</span>
			<span class="text-ui text-fg-tertiary">Design system</span>
		</div>
		<nav class="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" aria-label="Sections">
			{#each nav as [id, label] (id)}
				<a
					href="#{id}"
					class="inline-flex h-7 shrink-0 items-center rounded-control px-2 text-ui text-fg-secondary transition-colors-fast hover:bg-hover hover:text-fg focus-ring"
					>{label}</a
				>
			{/each}
		</nav>
		<SegmentedControl
			aria-label="Panes"
			size="sm"
			bind:value={view}
			items={[
				{ value: 'split', text: 'Split' },
				{ value: 'light', text: 'Light' },
				{ value: 'dark', text: 'Dark' }
			]}
		/>
		<div class="flex items-center gap-2">
			<span class="text-label text-fg-tertiary">App theme</span>
			<ThemeToggle />
		</div>
	</header>

	{#if only !== 'workspace'}
		<div class="grid" style="grid-template-columns: repeat({panes.length}, minmax(0, 1fr))">
			{#each panes as t (t)}
				<ThemePane theme={t} class="border-r border-line last:border-r-0">
					<div class="flex items-center gap-2 px-8 pt-6">
						<span class="inline-flex h-5 items-center rounded-full bg-active px-2 text-label font-medium text-fg-secondary"
							>{t === 'light' ? 'Light' : 'Dark'}</span
						>
						{#if theme.resolved === t}<span class="text-label text-fg-tertiary">matches the app theme</span>{/if}
					</div>
					<TokensShowcase theme={t} />
					<ComponentsShowcase theme={t} />
				</ThemePane>
			{/each}
		</div>
	{/if}

	<section id="workspace" data-section="workspace" class="flex scroll-mt-16 flex-col gap-6 border-t border-line bg-app px-8 py-10">
		<header class="flex flex-col gap-1">
			<h2 class="text-heading">Workspace preview</h2>
			<p class="max-w-[640px] text-body text-fg-secondary">
				A composition check, not the workspace: top bar, Parts, canvas with floating chrome, and the Params panel with
				overridden values. The model is a static SVG stand-in for the viewer.
			</p>
		</header>
		{#each panes as t (t)}
			<ThemePane theme={t} class="rounded-panel bg-transparent" >
				<div data-workspace={t}><WorkspacePreview theme={t} /></div>
			</ThemePane>
		{/each}
	</section>
</div>
