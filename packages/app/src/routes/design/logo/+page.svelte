<script lang="ts">
	import type { Component } from 'svelte';
	import { page } from '$app/state';
	import { X } from '@lucide/svelte';
	import ThemePane from '../ThemePane.svelte';
	import LogoCurrent from '$lib/components/app/logo.svelte';
	import LogoPin from '$lib/components/app/logo-pin.svelte';
	import LogoFace from '$lib/components/app/logo-face.svelte';
	import LogoDuo from '$lib/components/app/logo-duo.svelte';
	import LogoFillet from '$lib/components/app/logo-fillet.svelte';
	import LogoBlock from '$lib/components/app/logo-block.svelte';

	type Concept = { key: string; name: string; file: string; idea: string; mark: Component<{ size?: number }> };

	const concepts: Concept[] = [
		{
			key: 'pin',
			name: 'Pin',
			file: 'logo-pin.svelte',
			idea: 'A note pin (the comment-pin shape) holding a small solid. A note, placed on geometry.',
			mark: LogoPin
		},
		{
			key: 'face',
			name: 'Face',
			file: 'logo-face.svelte',
			idea: 'A solid with one face picked out in the accent and lifted off the body: the moment you select a face to talk about it.',
			mark: LogoFace
		},
		{
			key: 'fillet',
			name: 'Fillet',
			file: 'logo-fillet.svelte',
			idea: 'A P drawn as a sketch profile. The bowl is one fillet, and its centre is marked like a construction point.',
			mark: LogoFillet
		},
		{
			key: 'duo',
			name: 'Duo',
			file: 'logo-duo.svelte',
			idea: 'The app’s avatar language: an agent (graphite squircle) and a human (circle, in the accent) stacked like avatars.',
			mark: LogoDuo
		},
		{
			key: 'block',
			name: 'Block',
			file: 'logo-block.svelte',
			idea: 'A P extruded from a sketch, in oblique projection so the letter stays legible. The only fully monochrome concept.',
			mark: LogoBlock
		},
		{
			key: 'current',
			name: 'Current',
			file: 'logo.svelte',
			idea: 'The Parasocial cloud: a pearl surface transitioning into a luminous wire grid.',
			mark: LogoCurrent
		}
	];

	const only = page.url.searchParams.get('only');
	const shown = $derived(only ? concepts.filter((c) => only.split(',').includes(c.key)) : concepts);
	const sizes = [16, 24, 32, 64, 96];
	const themes = ['light', 'dark'] as const;
</script>

<svelte:head><title>Logo concepts · Parasocial</title></svelte:head>

<div class="min-h-dvh bg-app text-fg">
	<header data-design-header class="flex h-12 items-center gap-3 border-b border-line-subtle bg-panel px-6">
		<span class="text-ui font-heading font-medium">Parasocial</span>
		<span class="text-ui text-fg-tertiary">Logo concepts</span>
		<a href="/design" class="ml-auto text-ui text-fg-secondary hover:text-fg">Design system</a>
	</header>

	{#if !only}
		<section data-overview class="grid grid-cols-2">
			{#each themes as t (t)}
				<ThemePane theme={t} class="px-6 py-6">
					<div class="flex items-end gap-8">
						{#each concepts as c (c.key)}
							<div class="flex flex-col items-center gap-3">
								<c.mark size={64} />
								<div class="flex items-end gap-2">
									<c.mark size={32} />
									<c.mark size={24} />
									<c.mark size={16} />
								</div>
								<span class="text-label text-fg-secondary">{c.name}</span>
							</div>
						{/each}
					</div>
				</ThemePane>
			{/each}
		</section>
	{/if}

	{#each shown as c, i (c.key)}
		<section data-concept={c.key} class="border-t border-line">
			<header class="flex items-baseline gap-3 px-6 pt-6 pb-4">
				<span class="text-label text-fg-tertiary tabular">{String(i + 1).padStart(2, '0')}</span>
				<h2 class="text-title">{c.name}</h2>
				<p class="text-body text-fg-secondary">{c.idea}</p>
				<code class="ml-auto text-label text-fg-tertiary">{c.file}</code>
			</header>
			<div class="grid grid-cols-2">
				{#each themes as t (t)}
					<ThemePane theme={t} class="flex flex-col gap-4 px-6 py-6">
						<!-- size ramp -->
						<div class="flex items-end gap-6 rounded-panel bg-panel p-5 shadow-xs">
							{#each sizes as s (s)}
								<div class="flex flex-col items-center gap-2">
									<c.mark size={s} />
									<span class="text-caption text-fg-tertiary tabular">{s}</span>
								</div>
							{/each}
							<div class="ml-auto flex items-end gap-3 self-stretch rounded-md bg-canvas p-3">
								<c.mark size={16} />
								<c.mark size={24} />
							</div>
						</div>

						<!-- top bar -->
						<div class="overflow-hidden rounded-panel border border-line-subtle bg-panel shadow-xs">
							<div class="flex h-12 items-center gap-3 border-b border-line-subtle px-4">
								<span class="flex items-center gap-2">
									<c.mark size={28} />
									<span class="text-body font-heading font-medium">Parasocial</span>
								</span>
								<span class="text-fg-tertiary">/</span>
								<span class="text-body text-fg-secondary">Hinge bracket</span>
								<span class="ml-auto inline-flex h-7 items-center rounded-control bg-accent px-3 text-ui font-medium text-fg-on-accent">Share</span>
							</div>
							<div class="h-10 bg-canvas"></div>
						</div>

						<!-- favicon: browser tab strip -->
						<div class="overflow-hidden rounded-panel border border-line-subtle bg-app">
							<div class="flex h-10 items-end gap-1 px-2 pt-2">
								<span class="grid h-8 w-9 place-items-center rounded-t-md"><c.mark size={16} /></span>
								<span class="flex h-8 w-56 items-center gap-2 rounded-t-md bg-panel px-3">
									<c.mark size={16} />
									<span class="truncate text-ui">Hinge bracket · Parasocial</span>
									<X size={12} class="ml-auto text-fg-tertiary" />
								</span>
								<span class="flex h-8 w-44 items-center gap-2 rounded-t-md px-3 text-fg-secondary">
									<c.mark size={16} />
									<span class="truncate text-ui">Documents</span>
								</span>
							</div>
							<div class="flex h-9 items-center bg-panel px-3">
								<span class="flex h-6 flex-1 items-center rounded-full bg-input px-3 text-label text-fg-tertiary">parasocial.app/d/hinge-bracket</span>
							</div>
						</div>
					</ThemePane>
				{/each}
			</div>
		</section>
	{/each}
</div>
