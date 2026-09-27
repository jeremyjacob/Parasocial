<script lang="ts" module>
	export type DisplayMode = 'shaded' | 'shaded-edges' | 'wireframe' | 'hidden-line';
	export type SelectionFilter = 'face' | 'edge' | 'vertex' | 'part';
</script>

<script lang="ts">
	import {
		Box,
		Boxes,
		Scissors,
		Grid3x3,
		Square,
		SquareDashed,
		Filter,
		ChevronDown,
		Maximize
	} from '@lucide/svelte';
	import { cn } from '$lib/utils';
	import { DropdownMenu, type MenuEntry } from '$lib/components/ui/menu';
	import { IconButton } from '$lib/components/ui/button';
	import { Tooltip } from '$lib/components/ui/tooltip';
	import { mergeProps } from 'svelte-toolbelt';

	type Props = {
		display?: DisplayMode;
		section?: boolean;
		grid?: boolean;
		origin?: boolean;
		ortho?: boolean;
		filters?: SelectionFilter[];
		zoom?: number;
		orientation?: 'horizontal' | 'vertical';
		class?: string;
		onZoomToFit?: () => void;
	};
	let {
		display = $bindable('shaded-edges'),
		section = $bindable(false),
		grid = $bindable(true),
		origin = $bindable(true),
		ortho = $bindable(false),
		filters = $bindable(['face', 'edge', 'vertex', 'part']),
		zoom = $bindable(100),
		orientation = 'horizontal',
		class: className,
		onZoomToFit
	}: Props = $props();

	const displayIcons = { shaded: Box, 'shaded-edges': Boxes, wireframe: Grid3x3, 'hidden-line': SquareDashed };
	const displayNames: Record<DisplayMode, string> = {
		shaded: 'Shaded',
		'shaded-edges': 'Shaded with edges',
		wireframe: 'Wireframe',
		'hidden-line': 'Hidden line'
	};

	const displayItems = $derived<MenuEntry[]>([
		{ type: 'label', label: 'Display' },
		...(Object.keys(displayNames) as DisplayMode[]).map((m, i) => ({
			type: 'checkbox' as const,
			label: displayNames[m],
			checked: display === m,
			shortcut: ['alt', String(i + 1)],
			onCheckedChange: () => (display = m)
		})),
		{ type: 'separator' },
		{ type: 'checkbox', label: 'Ground grid', checked: grid, shortcut: ['G'], keepOpen: true, onCheckedChange: (v: boolean) => (grid = v) },
		{ type: 'checkbox', label: 'Origin', checked: origin, shortcut: ['shift', 'G'], keepOpen: true, onCheckedChange: (v: boolean) => (origin = v) }
	]);

	const filterNames: Record<SelectionFilter, string> = { face: 'Faces', edge: 'Edges', vertex: 'Vertices', part: 'Parts' };
	const filterItems = $derived<MenuEntry[]>([
		{ type: 'label', label: 'Selectable' },
		...(Object.keys(filterNames) as SelectionFilter[]).map((f) => ({
			type: 'checkbox' as const,
			label: filterNames[f],
			checked: filters.includes(f),
			keepOpen: true,
			onCheckedChange: (v: boolean) => (filters = v ? [...filters, f] : filters.filter((x) => x !== f))
		}))
	]);

	const zoomItems: MenuEntry[] = [
		{ label: 'Zoom to fit', icon: Maximize, shortcut: ['F'], onSelect: () => onZoomToFit?.() },
		{ label: 'Zoom to selection', shortcut: ['shift', 'F'] },
		{ type: 'separator' },
		{ label: '50%', onSelect: () => (zoom = 50) },
		{ label: '100%', onSelect: () => (zoom = 100) },
		{ label: '200%', onSelect: () => (zoom = 200) }
	];

	const DisplayIcon = $derived(displayIcons[display]);
	const filtered = $derived(filters.length < 4);
</script>

<!-- Concentric: radius 10, padding 2 → 28px buttons at radius 8 (the IconButton lg radius). -->
<div
	role="toolbar"
	aria-label="View"
	aria-orientation={orientation}
	class={cn(
		'inline-flex items-center gap-px rounded-[10px] bg-elevated p-0.5 shadow-toolbar',
		orientation === 'vertical' && 'flex-col',
		className
	)}
>
	<DropdownMenu items={displayItems} side={orientation === 'vertical' ? 'left' : 'bottom'} align="end">
		{#snippet trigger(props)}
			<Tooltip label="Display: {displayNames[display]}">
				{#snippet trigger(tp)}
					<button
						{...mergeProps(tp, props)}
						aria-label="Display mode"
						class="inline-flex size-7 items-center justify-center rounded-md text-fg-secondary transition-colors-fast hover:bg-hover hover:text-fg focus-ring data-[state=open]:bg-active"
					>
						<DisplayIcon />
					</button>
				{/snippet}
			</Tooltip>
		{/snippet}
	</DropdownMenu>
	<IconButton label="Section view" shortcut={['S']} active={section} onclick={() => (section = !section)} class="rounded-md">
		<Scissors />
	</IconButton>
	<IconButton
		label={ortho ? 'Orthographic (switch to perspective)' : 'Perspective (switch to orthographic)'}
		onclick={() => (ortho = !ortho)}
		class="rounded-md"
	>
		{#if ortho}<Square />{:else}<Box />{/if}
	</IconButton>
	<DropdownMenu items={filterItems} side={orientation === 'vertical' ? 'left' : 'bottom'} align="end">
		{#snippet trigger(props)}
			<Tooltip label="Selection filter">
				{#snippet trigger(tp)}
					<button
						{...mergeProps(tp, props)}
						aria-label="Selection filter"
						class={cn(
							'relative inline-flex size-7 items-center justify-center rounded-md transition-colors-fast hover:bg-hover hover:text-fg focus-ring data-[state=open]:bg-active',
							filtered ? 'text-accent-fg' : 'text-fg-secondary'
						)}
					>
						<Filter />
						{#if filtered}<span class="absolute top-1 right-1 size-1.5 rounded-full bg-accent"></span>{/if}
					</button>
				{/snippet}
			</Tooltip>
		{/snippet}
	</DropdownMenu>
	<span class={cn('bg-line', orientation === 'vertical' ? 'my-0.5 h-px w-5' : 'mx-0.5 h-4 w-px')} aria-hidden="true"
	></span>
	{#if orientation === 'vertical'}
		<!-- icon-width control so the vertical cluster stays one icon wide -->
		<IconButton label="Zoom to fit" shortcut={['F']} tooltipSide="left" onclick={() => onZoomToFit?.()}><Maximize /></IconButton>
	{:else}
	<DropdownMenu items={zoomItems} side="bottom" align="end">
			{#snippet trigger(props)}
				<button
					{...props}
					aria-label="Zoom {zoom}%"
					class="inline-flex h-7 items-center gap-0.5 rounded-md pr-1 pl-2 text-ui font-medium text-fg-secondary tabular transition-colors-fast hover:bg-hover hover:text-fg focus-ring data-[state=open]:bg-active"
				>
					{zoom}%<ChevronDown size={12} class="text-fg-tertiary" />
				</button>
			{/snippet}
		</DropdownMenu>
	{/if}
</div>
