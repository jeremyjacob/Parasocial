<script lang="ts">
	import { Play } from '@lucide/svelte';
	import { partColors, motion, selection } from '$lib/styles/tokens';
	import { Button } from '$lib/components/ui/button';
	import { SelectionLabel } from '$lib/components/ui/viewport';
	import Section from './Section.svelte';
	import Specimen from './Specimen.svelte';
	import TokenSwatch from './TokenSwatch.svelte';

	let { theme }: { theme: 'light' | 'dark' } = $props();

	type Tok = { name: string; kind?: 'fill' | 'text' | 'line'; label?: string };
	const t = (kind: Tok['kind'], ...names: string[]): Tok[] => names.map((name) => ({ name, kind }));
	const groups: { title: string; note?: string; tokens: Tok[] }[] = [
		{
			title: 'Surfaces',
			note: 'app → canvas → panel → input/control → elevated',
			tokens: t('fill', '--bg-app', '--bg-canvas', '--bg-panel', '--bg-input', '--bg-control', '--bg-elevated', '--bg-hover', '--bg-active')
		},
		{
			title: 'Text · Lines',
			tokens: [
				...t('text', '--fg-primary', '--fg-secondary', '--fg-tertiary', '--fg-disabled'),
				...t('line', '--border-subtle', '--border-default', '--border-strong', '--border-focus')
			]
		},
		{
			title: 'Accent · Status',
			tokens: t('fill', '--accent', '--accent-hover', '--accent-subtle', '--override', '--status-ok', '--status-warning', '--status-error', '--status-info')
		},
		{
			title: 'Selection · overlays',
			note: 'orange is reserved for this',
			tokens: [
				...t('fill', '--selection-preselect', '--selection-selected-stroke', '--selection-selected-fill'),
				...t('fill', '--bg-tooltip', '--bg-overlay', '--agent')
			]
		}
	];
	const short = (n: string) => n.replace(/^--(bg|fg|border|status|selection)-/, '').replace(/^--/, '');

	const typeScale = [
		{ cls: 'text-display', name: 'display', spec: '30/38 · −1.5%', sample: 'Bracket', weight: 'font-heading font-medium' },
		{ cls: 'text-heading', name: 'heading', spec: '22/30 · −1%', sample: 'Create your first document', weight: 'font-heading font-medium' },
		{ cls: 'text-title', name: 'title', spec: '17/24', sample: 'Connect an agent', weight: 'font-heading font-medium' },
		{ cls: 'text-section', name: 'section', spec: '14/20', sample: 'Properties', weight: 'font-heading font-medium' },
		{ cls: 'text-body', name: 'body', spec: '13/20', sample: 'Wall too thin here, needs 2 mm.', weight: '' },
		{ cls: 'text-ui', name: 'ui', spec: '12/16 · default', sample: 'Shaded with edges', weight: 'font-medium' },
		{ cls: 'text-label', name: 'label', spec: '11/16 · +1%', sample: 'Corner radius', weight: 'text-fg-secondary' },
		{ cls: 'text-caption', name: 'caption', spec: '10/14 · +2%', sample: 'KBD · BADGE', weight: 'text-fg-tertiary' }
	];

	const radii = [
		{ name: 'sm', px: 4, use: 'chips, checkbox, segment thumb' },
		{ name: 'control', px: 6, use: 'inputs, buttons, menu items' },
		{ name: 'md', px: 8, use: 'toolbar buttons, cards' },
		{ name: 'popover', px: 10, use: 'menus, popovers' },
		{ name: 'panel', px: 12, use: 'toolbar, panels' },
		{ name: 'dialog', px: 14, use: 'dialogs' }
	];

	const shadows = ['xs', 'control', 'toolbar', 'popover', 'dialog'];

	const eases = [
		{ name: 'ease-out', css: 'var(--ease-out)', v: motion.easeOut },
		{ name: 'ease-spring', css: 'var(--ease-spring)', v: motion.easeSpring },
		{ name: 'ease-in-out', css: 'var(--ease-in-out)', v: motion.easeInOut }
	];
	let played = $state(false);

	function shade(c: string) {
		return `radial-gradient(circle at 34% 28%, color-mix(in oklab, ${c}, white 38%) 0%, ${c} 42%, color-mix(in oklab, ${c}, black 42%) 100%)`;
	}
</script>

<Section id="color" title="Color" description="Neutral greys and one blue accent. Orange belongs to selection and nothing else. Every value below is read live from this pane's theme.">
	<div class="grid grid-cols-1 gap-3">
		{#each groups as g (g.title)}
			<Specimen title={g.title} note={g.note}>
				<div class="grid grid-cols-8 gap-3">
					{#each g.tokens as tok (tok.name)}
						<TokenSwatch name={tok.name} kind={tok.kind} label={short(tok.name)} />
					{/each}
				</div>
			</Specimen>
		{/each}
	</div>
</Section>

<Section id="parts" title="Part palette" description="Assigned round-robin, Onshape style. Mid-value and low chroma so shading, edges and the orange selection read on top. No orange, no accent-blue.">
	<Specimen title="Shaded preview" note="{theme} variant · tokens.ts partColors" surface="canvas">
		<div class="grid grid-cols-5 gap-x-3 gap-y-4">
			{#each partColors as p, i (p.id)}
				{@const c = theme === 'dark' ? p.dark : p.light}
				<div class="flex flex-col items-center gap-2">
					<div class="relative size-14">
						<div class="size-14 rounded-full shadow-[0_6px_12px_-6px_rgb(0_0_0/0.4)]" style="background:{shade(c)}"></div>
						{#if i === 2}
							<!-- selected: translucent orange fill + stroke -->
							<div
								class="absolute inset-0 rounded-full"
								style="background: {selection[theme].selectedFill}; opacity: {selection[theme].selectedFillOpacity}; box-shadow: 0 0 0 1.5px {selection[theme].selectedStroke}"
							></div>
						{:else if i === 7}
							<div class="absolute inset-0 rounded-full" style="box-shadow: 0 0 0 1.5px {selection[theme].preselect}"></div>
						{/if}
					</div>
					<div class="flex flex-col items-center">
						<span class="text-label font-medium text-fg">{p.name}</span>
						<span class="font-mono text-caption text-fg-tertiary">{c}</span>
					</div>
				</div>
			{/each}
		</div>
		<p class="text-label text-fg-tertiary">Iris shows the selected state (fill + stroke), Pine the preselect stroke.</p>
	</Specimen>
</Section>

<Section id="type" title="Typography" description="Inter for body text and controls, Montserrat for headings; both self-hosted. A compact UI scale: 12px is the default control text, 11px labels sit in secondary grey.">
	<Specimen title="Scale">
		<div class="flex flex-col">
			{#each typeScale as t (t.name)}
				<div class="grid grid-cols-[88px_1fr_auto] items-baseline gap-4 border-b border-line-subtle py-2.5 last:border-b-0">
					<span class="font-mono text-caption text-fg-tertiary">text-{t.name}</span>
					<span class="{t.cls} {t.weight} truncate">{t.sample}</span>
					<span class="font-mono text-caption text-fg-tertiary">{t.spec}</span>
				</div>
			{/each}
		</div>
	</Specimen>
	<div class="grid grid-cols-2 gap-3">
		<Specimen title="Tabular numerals" note="font-variant-numeric">
			<div class="grid grid-cols-2 gap-x-6 text-ui">
				<div class="flex flex-col gap-1 text-fg-tertiary">
					<span class="text-label">proportional</span>
					<span class="text-fg">1,111.11</span><span class="text-fg">8,888.88</span>
				</div>
				<div class="flex flex-col gap-1 text-fg-tertiary tabular">
					<span class="text-label">tabular</span>
					<span class="text-fg">1,111.11</span><span class="text-fg">8,888.88</span>
				</div>
			</div>
		</Specimen>
		<Specimen title="Weights">
			<div class="flex flex-col gap-1 text-ui">
				<span class="font-normal">400 · Body and values</span>
				<span class="font-medium">500 · Controls, tabs, menu</span>
				<span class="font-heading font-medium text-section">500 · Montserrat headings</span>
			</div>
		</Specimen>
	</div>
</Section>

<Section id="spacing" title="Spacing and radii" description="Everything sits on a 4px grid. Controls are 28px, rows 32px, panel sections 40px title rows with 16px side padding.">
	<div class="grid grid-cols-2 gap-3">
		<Specimen title="4px grid">
			<div class="flex flex-col gap-1.5">
				{#each [1, 2, 3, 4, 6, 8, 10, 12, 16] as n (n)}
					<div class="flex items-center gap-3">
						<span class="w-8 font-mono text-caption text-fg-tertiary">{n * 4}</span>
						<div class="h-2 rounded-xs bg-accent/70" style="width:{n * 4}px"></div>
						<span class="font-mono text-caption text-fg-tertiary">{n}</span>
					</div>
				{/each}
			</div>
		</Specimen>
		<Specimen title="Radii">
			<div class="grid grid-cols-3 gap-3">
				{#each radii as r (r.name)}
					<div class="flex flex-col gap-1.5">
						<div class="h-10 bg-input shadow-[inset_0_0_0_1px_var(--border-default)]" style="border-radius:{r.px}px"></div>
						<span class="text-label font-medium">{r.name} <span class="text-fg-tertiary tabular">{r.px}</span></span>
					</div>
				{/each}
			</div>
		</Specimen>
		<Specimen title="Concentric nesting" note="inner = outer − padding" class="col-span-2">
			<div class="grid grid-cols-3 items-end gap-6">
				<div class="flex flex-col items-center gap-2">
					<div class="nest bg-elevated shadow-toolbar" style="--r: 12px; --p: 4px">
						<div class="flex gap-0.5">
							<div class="nest-inner grid size-8 place-items-center bg-accent text-caption font-semibold text-fg-on-accent">8</div>
							<div class="nest-inner size-8 bg-hover"></div>
							<div class="nest-inner size-8 bg-hover"></div>
						</div>
					</div>
					<span class="text-label text-fg-secondary tabular">Toolbar 12 − 4 = 8</span>
				</div>
				<div class="flex flex-col items-center gap-2">
					<div class="nest bg-input" style="--r: 6px; --p: 2px">
						<div class="flex">
							<div class="nest-inner h-6 w-12 bg-control shadow-thumb"></div>
							<div class="h-6 w-12"></div>
						</div>
					</div>
					<span class="text-label text-fg-secondary tabular">Segmented 6 − 2 = 4</span>
				</div>
				<div class="flex flex-col items-center gap-2">
					<div class="flex gap-3">
						<div class="rounded-[16px] bg-elevated p-2 shadow-toolbar">
							<div class="size-10 rounded-[8px] bg-ok/25 ring-1 ring-ok/50"></div>
						</div>
						<div class="rounded-[16px] bg-elevated p-2 shadow-toolbar">
							<div class="size-10 rounded-[16px] bg-error/20 ring-1 ring-error/50"></div>
						</div>
					</div>
					<span class="text-label text-fg-secondary tabular">16 − 8 = 8 ✓ · 16 inside 16 ✗</span>
				</div>
			</div>
		</Specimen>
	</div>
</Section>

<Section id="elevation" title="Elevation and motion" description="Light mode separates with hairline + soft shadow; dark mode gets lighter as it rises and adds a 1px top highlight, so layers read without grey mush.">
	<div class="grid grid-cols-2 gap-3">
		<Specimen title="Shadows" surface="canvas" class="col-span-2">
			<div class="grid grid-cols-5 gap-4 py-2">
				{#each shadows as s (s)}
					<div class="flex flex-col items-center gap-2">
						<div class="h-14 w-full rounded-panel bg-elevated" style="box-shadow: var(--elev-{s})"></div>
						<span class="font-mono text-caption text-fg-tertiary">shadow-{s}</span>
					</div>
				{/each}
			</div>
		</Specimen>
		<Specimen title="Motion" note="150 · 200 · 250 ms" class="col-span-2">
			<div class="flex flex-col gap-2.5">
				{#each eases as e (e.name)}
					<div class="grid grid-cols-[96px_1fr_120px] items-center gap-3">
						<span class="font-mono text-caption text-fg-secondary">{e.name}</span>
						<div class="relative h-6 rounded-full bg-input">
							<div
								class="absolute top-1 size-4 rounded-full bg-accent shadow-thumb"
								style="transition: left var(--duration-slow) {e.css}; left: {played ? 'calc(100% - 20px)' : '4px'}"
							></div>
						</div>
						<span class="font-mono text-caption text-fg-tertiary">{e.v.join(', ')}</span>
					</div>
				{/each}
				<div class="flex items-center gap-3">
					<Button size="sm" onclick={() => (played = !played)}><Play size={12} />Play</Button>
					<span class="text-label text-fg-tertiary">Durations collapse to 0 under prefers-reduced-motion.</span>
				</div>
			</div>
		</Specimen>
		<Specimen title="Selection" note="viewport tokens" surface="canvas" class="col-span-2">
			<div class="flex items-center gap-8 py-2">
				<div class="flex items-center gap-3">
					<div class="h-12 w-20 rounded-sm bg-[var(--part-graphite)] shadow-[0_0_0_1.5px_var(--selection-preselect)]"></div>
					<span class="text-label text-fg-secondary">Preselect<br /><span class="text-fg-tertiary">stroke on hover</span></span>
				</div>
				<div class="flex items-center gap-3">
					<div class="relative h-12 w-20 rounded-sm bg-[var(--part-graphite)]">
						<div class="absolute inset-0 rounded-sm bg-selected-fill shadow-[0_0_0_1.5px_var(--selection-selected-stroke)]"></div>
					</div>
					<span class="text-label text-fg-secondary">Selected<br /><span class="text-fg-tertiary">fill + stroke</span></span>
				</div>
				<SelectionLabel value="175.2" unit="mm²" />
			</div>
		</Specimen>
	</div>
</Section>
