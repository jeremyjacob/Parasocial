<script lang="ts">
	import {
		Plus,
		Minus,
		Eye,
		Grid2x2,
		Settings2,
		AlignLeft,
		AlignCenter,
		AlignRight,
		ArrowDown,
		ArrowRight,
		CornerDownLeft,
		Search,
		Box,
		Circle,
		Spline,
		Dot,
		Copy,
		Trash2,
		Focus,
		EyeOff,
		MessageCircle,
		Ruler,
		Crosshair,
		Code,
		MoreHorizontal,
		Diameter,
		RotateCw,
		Maximize2,
		Layers,
		FileCode2,
		Link,
		Bot,
		Scan,
		ChevronDown
	} from '@lucide/svelte';
	import { partColors } from '$lib/styles/tokens';
	import { Button, IconButton } from '$lib/components/ui/button';
	import { Toggle, ToggleGroup } from '$lib/components/ui/toggle';
	import { SegmentedControl } from '$lib/components/ui/segmented-control';
	import { Tabs } from '$lib/components/ui/tabs';
	import { Input } from '$lib/components/ui/input';
	import { NumberField, createEvaluator } from '$lib/components/ui/number-field';
	import { Select, Combobox } from '$lib/components/ui/select';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Switch } from '$lib/components/ui/switch';
	import { Slider } from '$lib/components/ui/slider';
	import { Tooltip, tooltipClass } from '$lib/components/ui/tooltip';
	import { Popover } from '$lib/components/ui/popover';
	import { DropdownMenu, ContextMenu, menuStyles, type MenuEntry } from '$lib/components/ui/menu';
	import { Dialog } from '$lib/components/ui/dialog';
	import { CommandPalette, type CommandGroup } from '$lib/components/ui/command';
	import { toast, ToastItem } from '$lib/components/ui/toast';
	import { Kbd } from '$lib/components/ui/kbd';
	import { Badge, StatusBadge } from '$lib/components/ui/badge';
	import { Avatar, AvatarStack, type Person } from '$lib/components/ui/avatar';
	import { ColorSwatch } from '$lib/components/ui/color-swatch';
	import { PropertySection, PropertyRow, FieldGrid } from '$lib/components/ui/property';
	import { ListRow } from '$lib/components/ui/list-row';
	import {
		FloatingToolbar,
		SelectionLabel,
		StatusPill,
		ViewportControls,
		ViewCube
	} from '$lib/components/ui/viewport';
	import { ProgressLine, Skeleton, EmptyState } from '$lib/components/ui/feedback';
	import { NoteThread, NoteStatusChip, MentionChip, VersionChip } from '$lib/components/ui/notes';
	import { TopBar } from '$lib/components/ui/top-bar';
	import { cn, keyGlyph } from '$lib/utils';
	import Section from './Section.svelte';
	import Specimen from './Specimen.svelte';

	let { theme }: { theme: 'light' | 'dark' } = $props();

	// ---- demo state
	let seg = $state('horizontal');
	let tab = $state('properties');
	let filters = $state(['face', 'edge']);
	let pressed = $state(true);
	let text = $state('Bracket');
	let w = $state(250);
	let h = $state(128);
	let thickness = $state(3.5);
	let fillet = $state(2);
	let fexpr = $state<string | undefined>('=thickness/2 + 0.25');
	let angle = $state(0);
	let holes = $state(4);
	let lastEvent = $state('—');
	let config = $state('m4');
	let material = $state('pla');
	let combo = $state('thickness');
	let clip = $state(true);
	let indet = $state(true);
	let sw = $state(true);
	let opacity = $state(64);
	let swatch = $state('sage');
	let dialogOpen = $state(false);
	let cmdOpen = $state(false);
	let tool = $state<'select' | 'note' | 'pencil' | 'measure'>('select');
	let pillOpen = $state(true);

	const evaluate = createEvaluator({ scope: { width: 120, height: 80, thickness: 3.5 } });

	const menuItems: MenuEntry[] = [
		{ label: 'Add note', icon: MessageCircle, shortcut: ['C'] },
		{ label: 'Measure', icon: Ruler, shortcut: ['M'] },
		{ label: 'Select all from this operation', icon: Crosshair },
		{ type: 'separator' },
		{ label: 'Isolate', icon: Focus, shortcut: ['I'] },
		{ label: 'Hide', icon: EyeOff, shortcut: ['H'] },
		{ label: 'Zoom to', icon: Scan, shortcut: ['shift', 'F'] },
		{ type: 'separator' },
		{ label: 'Reveal source', icon: Code, shortcut: ['mod', 'enter'] },
		{ label: 'Copy reference', icon: Copy },
		{ type: 'sub', label: 'Select', items: [{ label: 'Tangent chain' }, { label: 'Loop' }] }
	];

	const commandGroups: CommandGroup[] = [
		{
			heading: 'Actions',
			items: [
				{ id: 'note', label: 'Add note', icon: MessageCircle, shortcut: ['C'] },
				{ id: 'measure', label: 'Measure', icon: Ruler, shortcut: ['M'] },
				{ id: 'code', label: 'Toggle Code mode', icon: Code, shortcut: ['mod', '\\'] },
				{ id: 'export', label: 'Export…', icon: Box, shortcut: ['mod', 'shift', 'E'] }
			]
		},
		{
			heading: 'Params',
			items: [
				{ id: 'p-thick', label: 'thickness', icon: Ruler, hint: 'Bracket · 3.5 mm' },
				{ id: 'p-fillet', label: 'fillet_radius', icon: Ruler, hint: 'Bracket · 2 mm' }
			]
		},
		{
			heading: 'Notes',
			items: [{ id: 'n-12', label: 'Wall too thin here', icon: MessageCircle, hint: '#12 · Awaiting review' }]
		}
	];

	const people: Person[] = [
		{ name: 'Claude Code', kind: 'agent', status: 'working' },
		{ name: 'Codex', kind: 'agent', status: 'idle' },
		{ name: 'Maya Chen', kind: 'human', online: true },
		{ name: 'Jeremy Jacob', kind: 'human' },
		{ name: 'Ops Agent', kind: 'agent' }
	];

	const pc = (id: string) => {
		const p = partColors.find((x) => x.id === id)!;
		return theme === 'dark' ? p.dark : p.light;
	};
</script>

<Section id="controls" title="Controls" description="28px controls, 6px radius, filled at rest like Figma UI3. Hover adds a hairline, focus an accent hairline (fields) or a two-tone ring (buttons).">
	<div class="grid grid-cols-2 gap-3">
		<Specimen title="Button" note="primary · secondary · ghost · destructive" class="col-span-2">
			<div class="grid grid-cols-[72px_repeat(4,minmax(0,1fr))] items-center gap-x-3 gap-y-2.5">
				<span></span>
				{#each ['Default', 'Hover', 'Focus', 'Disabled'] as s (s)}<span class="text-label text-fg-tertiary">{s}</span>{/each}
				{#each [['primary', 'bg-accent-hover'], ['secondary', 'bg-control-hover'], ['ghost', 'bg-hover'], ['destructive', 'brightness-[0.94]']] as [v, hover] (v)}
					<span class="text-label text-fg-secondary">{v}</span>
					<div><Button variant={v as 'primary'}>{v === 'destructive' ? 'Delete part' : 'Create'}</Button></div>
					<div><Button variant={v as 'primary'} class={hover}>{v === 'destructive' ? 'Delete part' : 'Create'}</Button></div>
					<div><Button variant={v as 'primary'} class="shadow-focus">{v === 'destructive' ? 'Delete part' : 'Create'}</Button></div>
					<div><Button variant={v as 'primary'} disabled>{v === 'destructive' ? 'Delete part' : 'Create'}</Button></div>
				{/each}
			</div>
			<div class="flex items-center gap-2 border-t border-line-subtle pt-3">
				<Button size="sm">Small 24</Button>
				<Button size="md">Medium 28</Button>
				<Button size="lg">Large 32</Button>
				<Button variant="primary"><Plus />Add part</Button>
				<Button variant="secondary" loading>Saving</Button>
			</div>
		</Specimen>

		<Specimen title="IconButton · Toggle">
			<div class="flex items-center gap-1">
				<IconButton label="Add fill"><Plus /></IconButton>
				<IconButton label="Hover" class="bg-hover text-fg"><Minus /></IconButton>
				<IconButton label="Active" active><Grid2x2 /></IconButton>
				<IconButton label="Accent" variant="accent" active><Layers /></IconButton>
				<IconButton label="Secondary" variant="secondary"><Settings2 /></IconButton>
				<IconButton label="Disabled" disabled><Eye /></IconButton>
				<IconButton label="Focus" class="shadow-focus"><MoreHorizontal /></IconButton>
			</div>
			<div class="flex items-center gap-1">
				<Toggle label="Clip content" bind:pressed><Scan /></Toggle>
				<Toggle label="Snap" pressed={false}><Grid2x2 /></Toggle>
				<Toggle label="Show edges" text="Edges" pressed><Spline /></Toggle>
			</div>
			<ToggleGroup
				aria-label="Selection filter"
				bind:value={filters}
				items={[
					{ value: 'face', label: 'Faces', icon: Box, shortcut: ['1'] },
					{ value: 'edge', label: 'Edges', icon: Spline, shortcut: ['2'] },
					{ value: 'vertex', label: 'Vertices', icon: Dot, shortcut: ['3'] },
					{ value: 'part', label: 'Parts', icon: Layers, shortcut: ['4'] }
				]}
			/>
		</Specimen>

		<Specimen title="SegmentedControl · Tabs">
			<SegmentedControl
				aria-label="Direction"
				bind:value={seg}
				items={[
					{ value: 'vertical', icon: ArrowDown, label: 'Vertical layout' },
					{ value: 'horizontal', icon: ArrowRight, label: 'Horizontal layout' },
					{ value: 'wrap', icon: CornerDownLeft, label: 'Wrap' }
				]}
			/>
			<SegmentedControl
				aria-label="Visible"
				fill
				value="yes"
				items={[
					{ value: 'yes', text: 'Yes' },
					{ value: 'no', text: 'No' }
				]}
			/>
			<div class="-mx-2 border-y border-line-subtle">
				<Tabs
					bind:value={tab}
					items={[
						{ value: 'properties', label: 'Properties' },
						{ value: 'params', label: 'Params' },
						{ value: 'notes', label: 'Notes', count: 3 }
					]}
				>
					{#snippet actions()}
						<span class="text-label text-fg-tertiary tabular">100%</span>
					{/snippet}
				</Tabs>
			</div>
		</Specimen>

		<Specimen title="Input" note="default · focus · error · disabled">
			<Input bind:value={text} aria-label="Name" />
			<Input value="Search parts…" aria-label="Search" class="[--field-ring:var(--border-focus)]">
				{#snippet leading()}<Search />{/snippet}
			</Input>
			<Input value="bracket..ts" aria-label="File name" error="Names can't contain “..”" />
			<Input value="Read-only" aria-label="Disabled" disabled />
		</Specimen>

		<Specimen title="Select · Combobox">
			<Select
				aria-label="Configuration"
				bind:value={config}
				items={[
					{ value: 'default', label: 'Default' },
					{ value: 'm3', label: 'M3', hint: '2' },
					{ value: 'm4', label: 'M4', hint: '3' },
					{ value: 'draft', label: 'Print-draft', hint: '5' }
				]}
			/>
			<Select
				aria-label="Material"
				bind:value={material}
				items={[
					{ value: 'pla', label: 'PLA' },
					{ value: 'petg', label: 'PETG' },
					{ value: 'al', label: 'Aluminium 6061' }
				]}
				class="[--field-ring:var(--border-focus)]"
			/>
			<Combobox
				aria-label="Param"
				bind:value={combo}
				items={[
					{ value: 'thickness', label: 'thickness', hint: '3.5 mm' },
					{ value: 'width', label: 'width', hint: '120 mm' },
					{ value: 'fillet', label: 'fillet_radius', hint: '2 mm' }
				]}
			/>
			<Select aria-label="Disabled" disabled items={[{ value: 'x', label: 'Disabled' }]} value="x" />
		</Specimen>

		<Specimen title="Checkbox · Switch · Slider">
			<div class="grid grid-cols-2 gap-x-4">
				<div class="flex flex-col">
					<Checkbox bind:checked={clip} label="Clip content" />
					<Checkbox checked={false} label="Show hidden" />
					<Checkbox bind:indeterminate={indet} label="Some parts" />
					<Checkbox checked disabled label="Disabled" />
				</div>
				<div class="flex flex-col">
					<Switch bind:checked={sw} label="Live regen" />
					<Switch checked={false} label="Grid" />
					<Switch checked disabled label="Disabled" />
				</div>
			</div>
			<div class="flex items-center gap-3">
				<div class="w-16 shrink-0"><NumberField bind:value={opacity} unit="%" min={0} max={100} aria-label="Opacity" /></div>
				<Slider bind:value={opacity} aria-label="Opacity" />
			</div>
		</Specimen>

		<Specimen title="NumberField" note="drag the label · ↑↓ step · ⇧ coarse · ⌥ fine · =expressions · units" class="col-span-2">
			<div class="grid grid-cols-2 gap-x-6 gap-y-3">
				<PropertyRow label="Resizing">
					<FieldGrid>
						<NumberField label="W" bind:value={w} min={0} oncommit={(v) => (lastEvent = `commit W = ${v}`)} oninput={(v) => (lastEvent = `input W = ${v}`)} />
						<NumberField label="H" bind:value={h} min={0} oncommit={(v) => (lastEvent = `commit H = ${v}`)} />
					</FieldGrid>
				</PropertyRow>
				<PropertyRow label="Rotation · Holes">
					<FieldGrid>
						<NumberField icon={RotateCw} bind:value={angle} unit="°" step={1} aria-label="Rotation" />
						<NumberField label="#" bind:value={holes} min={1} max={12} step={1} precision={0} aria-label="Holes" />
					</FieldGrid>
				</PropertyRow>
				<PropertyRow label="thickness" layout="inline" overridden hint="Default 3 mm · bracket.ts:12">
					<NumberField
						bind:value={thickness}
						defaultValue={3}
						source="bracket.ts:12"
						unit="mm"
						min={1}
						max={10}
						step={0.5}
						{evaluate}
						aria-label="thickness"
						oncommit={(v, e) => (lastEvent = `commit thickness = ${v}${e ? ` (${e})` : ''}`)}
					/>
				</PropertyRow>
				<PropertyRow label="fillet_radius" layout="inline" overridden hint="Default 2 mm · bracket.ts:18">
					<NumberField
						bind:value={fillet}
						bind:expression={fexpr}
						defaultValue={2}
						source="bracket.ts:18"
						unit="mm"
						min={0}
						step={0.25}
						{evaluate}
						aria-label="fillet_radius"
						oncommit={(v, e) => (lastEvent = `commit fillet = ${v}${e ? ` (${e})` : ''}`)}
					/>
				</PropertyRow>
				<PropertyRow label="wall" layout="inline" hint="Out of bounds">
					<NumberField value={12} unit="mm" min={1} max={10} error="Max 10 mm (bracket.ts:14)" aria-label="wall" />
				</PropertyRow>
				<PropertyRow label="hole_count" layout="inline">
					<NumberField value={4} step={1} precision={0} disabled aria-label="hole_count" />
				</PropertyRow>
			</div>
			<div class="flex items-center gap-2 border-t border-line-subtle pt-3 text-label text-fg-tertiary">
				<span class="font-mono">{lastEvent}</span>
				<span class="ml-auto">Try <code class="font-mono text-fg-secondary">=width/4</code> or <code class="font-mono text-fg-secondary">1/4 in</code> in thickness</span>
			</div>
		</Specimen>
	</div>
</Section>

<Section id="overlays" title="Overlays" description="Floating surfaces: 10px radius, 4px padding, 6px item radius. Menus highlight in accent, like Figma. Tooltips are a dark pill with an arrow in both themes.">
	<div class="grid grid-cols-2 gap-3">
		<Specimen title="Tooltip" note="500 ms delay, instant between triggers" bodyClass="justify-center">
			<!-- Static renders (live tooltips need hover); hover any icon button on the page for the real one. -->
			<div class="flex items-start justify-center gap-8 py-2">
				<div class="flex flex-col items-center gap-1.5">
					<div class="w-28"><NumberField icon={AlignCenter} value={0} aria-label="Vertical padding" /></div>
					<div class="relative {tooltipClass}">
						Vertical padding
						<svg class="absolute -top-[5px] left-1/2 -translate-x-1/2 rotate-180 text-tooltip" width="10" height="5" viewBox="0 0 30 10"><polygon points="0,0 30,0 15,10" fill="currentColor" /></svg>
					</div>
				</div>
				<div class="flex flex-col items-center gap-1.5">
					<IconButton label="Measure" tooltip={false} class="bg-hover text-fg"><Ruler /></IconButton>
					<div class="relative {tooltipClass}">
						Measure<span class="text-fg-tooltip/55">M</span>
						<svg class="absolute -top-[5px] left-1/2 -translate-x-1/2 rotate-180 text-tooltip" width="10" height="5" viewBox="0 0 30 10"><polygon points="0,0 30,0 15,10" fill="currentColor" /></svg>
					</div>
				</div>
				<div class="flex flex-col items-center gap-1.5">
					<Tooltip label="Hover me" shortcut={['mod', 'K']}>
						{#snippet trigger(props)}<Button {...props} size="sm">Live tooltip</Button>{/snippet}
					</Tooltip>
				</div>
			</div>
		</Specimen>

		<Specimen title="Menu" note="static render of DropdownMenu / ContextMenu">
			<div class="{menuStyles.menuContent} relative w-full animate-none">
				<div class="{menuStyles.menuItem} group/item"><MessageCircle />Add note<span class={menuStyles.menuShortcut}>C</span></div>
				<div class="{menuStyles.menuItem} group/item" data-highlighted><Ruler />Measure<span class={menuStyles.menuShortcut}>M</span></div>
				<div class="{menuStyles.menuItem} group/item"><Crosshair />Select all from this operation</div>
				<div class={menuStyles.menuSeparator}></div>
				<div class="{menuStyles.menuItem} group/item"><Code />Reveal source<span class={menuStyles.menuShortcut}>{keyGlyph('mod')}{keyGlyph('enter')}</span></div>
				<div class="{menuStyles.menuItem} group/item" data-disabled><Copy />Copy reference</div>
				<div class={cn(menuStyles.menuItem, menuStyles.menuItemDestructive, 'group/item')}><Trash2 />Delete note</div>
			</div>
		</Specimen>

		<Specimen title="Triggers" note="open them" class="col-span-2">
			<div class="flex flex-wrap items-center gap-2">
				<DropdownMenu items={menuItems}>
					{#snippet trigger(props)}<Button {...props}>Dropdown <ChevronDown size={14} class="text-fg-tertiary" /></Button>{/snippet}
				</DropdownMenu>
				<Popover title="Part color">
					{#snippet trigger(props)}<Button {...props}><ColorSwatch color={pc(swatch)} size={12} />Popover</Button>{/snippet}
					<div class="grid grid-cols-5 gap-2">
						{#each partColors as p (p.id)}
							<ColorSwatch color={theme === 'dark' ? p.dark : p.light} label={p.name} size={24} selected={swatch === p.id} onclick={() => (swatch = p.id)} />
						{/each}
					</div>
				</Popover>
				<Dialog bind:open={dialogOpen} title="Connect an agent">
					{#snippet trigger(props)}<Button {...props}>Dialog</Button>{/snippet}
					<div class="flex flex-col gap-3">
						<Input value="https://parasocial.local/mcp/doc_8f2a" readonly aria-label="MCP URL">
							{#snippet trailing()}<IconButton label="Copy" size="sm"><Copy /></IconButton>{/snippet}
						</Input>
						<div class="rounded-md bg-input px-3 py-2 font-mono text-label text-fg-secondary">claude mcp add parasocial https://…/mcp</div>
					</div>
					{#snippet footer()}
						<Button variant="ghost" onclick={() => (dialogOpen = false)}>Cancel</Button>
						<Button variant="primary" onclick={() => (dialogOpen = false)}>Done</Button>
					{/snippet}
				</Dialog>
				<Button onclick={() => (cmdOpen = true)}>Command <Kbd keys={['mod', 'K']} /></Button>
				<Button onclick={() => toast.success('Exported bracket.step', { action: { label: 'Show', onClick: () => {} } })}>Toast</Button>
				<Button onclick={() => toast.error("Bracket didn't regenerate")}>Error toast</Button>
				<ContextMenu items={menuItems} class="flex h-7 items-center rounded-control border border-dashed border-line-strong px-3 text-label text-fg-tertiary">
					Right-click here
				</ContextMenu>
			</div>
			<CommandPalette bind:open={cmdOpen} groups={commandGroups} hotkey={theme === 'light'} />
		</Specimen>

		<Specimen title="Command palette" note="⌘K · inline render" class="col-span-2" surface="canvas">
			<CommandPalette inline groups={commandGroups} class="max-h-[340px]" />
		</Specimen>

		<Specimen title="Toast" note="dark pill in both themes, above the toolbar" class="col-span-2" surface="canvas">
			<div class="flex flex-col items-center gap-2">
				<ToastItem toast={{ message: 'Copied', kind: 'default' }} />
				<ToastItem toast={{ message: 'Exported bracket.step', kind: 'success', action: { label: 'Show', onClick: () => {} } }} />
				<ToastItem toast={{ message: "Couldn't load the model", kind: 'error', action: { label: 'Retry', onClick: () => {} } }} />
				<ToastItem toast={{ message: 'Regenerating Bracket…', kind: 'loading' }} />
			</div>
		</Specimen>
	</div>
</Section>

<Section id="display" title="Display" description="Small, quiet status: 6px dots, 20px chips. Agents are graphite squircles with a sparkle; working agents get a slow accent sweep.">
	<div class="grid grid-cols-2 gap-3">
		<Specimen title="Kbd · Badge · StatusBadge">
			<div class="flex flex-wrap items-center gap-2">
				<Kbd keys={['mod', 'K']} /><Kbd keys={['shift', 'P']} /><Kbd keys={['V']} /><Kbd keys={['mod', 'shift', 'E']} /><Kbd keys={['esc']} />
			</div>
			<div class="flex flex-wrap items-center gap-1.5">
				<Badge>Draft</Badge><Badge tone="accent">3 overrides</Badge><Badge tone="ok">Valid</Badge><Badge tone="warning">Slow</Badge><Badge tone="error">2 errors</Badge><Badge tone="outline">v14</Badge>
			</div>
			<div class="flex flex-wrap items-center gap-3">
				<StatusBadge status="ok" /><StatusBadge status="warning" /><StatusBadge status="error" /><StatusBadge status="pending" />
				<StatusBadge status="warning" label="Slow regen" /><StatusBadge status="error" label="Didn't regenerate" />
			</div>
		</Specimen>

		<Specimen title="Avatar · AvatarStack" note="humans round, agents squircle">
			<div class="flex items-center gap-3">
				{#each people as p (p.name)}<Avatar {...p} size={28} />{/each}
			</div>
			<div class="flex items-center gap-4">
				<AvatarStack people={people.filter((p) => p.kind === 'agent')} />
				<AvatarStack people={people} max={3} />
				<div class="flex items-center gap-2 text-label text-fg-secondary">
					<Avatar name="Claude Code" kind="agent" status="writing" size={20} />writing bracket.ts
				</div>
			</div>
		</Specimen>

		<Specimen title="ColorSwatch">
			<div class="flex items-center gap-2">
				{#each partColors as p (p.id)}
					<ColorSwatch color={theme === 'dark' ? p.dark : p.light} label={p.name} size={20} selected={swatch === p.id} onclick={() => (swatch = p.id)} />
				{/each}
			</div>
			<div class="flex items-center gap-3 text-label text-fg-secondary">
				<ColorSwatch color={pc('teal')} size={12} />12
				<ColorSwatch color={pc('teal')} size={16} />16
				<ColorSwatch color={pc('teal')} size={24} />24
				<ColorSwatch color={pc('chalk')} size={16} />light swatches keep a hairline
			</div>
		</Specimen>

		<Specimen title="Chips" note="notes, mentions, versions">
			<div class="flex flex-wrap items-center gap-1.5">
				<NoteStatusChip status="open" /><NoteStatusChip status="working" /><NoteStatusChip status="review" /><NoteStatusChip status="resolved" /><NoteStatusChip status="orphaned" />
			</div>
			<p class="text-body">
				Set <MentionChip kind="param" name="thickness" /> on <MentionChip kind="part" name="lid" color={pc('iris')} /> to match
				<MentionChip kind="entity" name="face:top" /> · <MentionChip kind="param" name="old_rib" broken />
			</p>
			<VersionChip version={14} time="14:02" summary="thickness 3 → 4" class="self-start" />
		</Specimen>
	</div>
</Section>

<Section id="panels" title="Panels and lists" description="Figma UI3 panel grammar: 40px section titles with action icons, 11px labels above a two-column field grid, 32px list rows with hover actions.">
	<div class="grid grid-cols-2 gap-3">
		<Specimen title="PropertySection" bodyClass="p-0 gap-0">
			<PropertySection title="Position">
				{#snippet actions()}<IconButton label="Align to origin" size="sm"><Maximize2 /></IconButton>{/snippet}
				<PropertyRow label="Alignment">
					<FieldGrid>
						<SegmentedControl aria-label="Horizontal alignment" fill value="left" items={[{ value: 'left', icon: AlignLeft, label: 'Left' }, { value: 'center', icon: AlignCenter, label: 'Center' }, { value: 'right', icon: AlignRight, label: 'Right' }]} />
						<SegmentedControl aria-label="Vertical alignment" fill value="top" items={[{ value: 'top', icon: ArrowDown, label: 'Top' }, { value: 'mid', icon: Minus, label: 'Middle' }, { value: 'bot', icon: ArrowRight, label: 'Bottom' }]} />
					</FieldGrid>
				</PropertyRow>
				<PropertyRow label="Position">
					<FieldGrid>
						<NumberField label="X" value={0} unit="mm" />
						<NumberField label="Y" value={2162} unit="mm" />
					</FieldGrid>
				</PropertyRow>
			</PropertySection>
			<PropertySection title="Appearance">
				{#snippet actions()}
					<IconButton label="Visibility" size="sm"><Eye /></IconButton>
				{/snippet}
				<FieldGrid>
					<PropertyRow label="Opacity"><NumberField icon={Grid2x2} value={100} unit="%" /></PropertyRow>
					<PropertyRow label="Color">
						<div class="field gap-2 px-2"><ColorSwatch color={pc('sage')} size={14} /><span>Sage</span></div>
					</PropertyRow>
				</FieldGrid>
			</PropertySection>
			<PropertySection title="Mass properties" collapsible open={false} meta="PLA · 1.24 g/cm³" />
		</Specimen>

		<Specimen title="ListRow" note="parts list" bodyClass="p-1.5 gap-0.5">
			<ListRow name="Bracket" color={pc('graphite')} selected />
			<ListRow name="Lid" color={pc('iris')} class="bg-hover" showActions status="error">
				{#snippet actions()}<IconButton label="Isolate" size="sm"><Focus /></IconButton>{/snippet}
			</ListRow>
			<ListRow name="Gasket" color={pc('teal')} status="warning" />
			<ListRow name="Hinge pin" color={pc('straw')} status="error" statusLabel="Error" />
			<ListRow name="Spacer" color={pc('rose')} visible={false} />
			<ListRow name="Clip" color={pc('sage')} busy>
				{#snippet trailing()}<Avatar name="Claude Code" kind="agent" status="working" size={20} />{/snippet}
			</ListRow>
			<div class="mt-1 border-t border-line-subtle pt-1.5">
				<ListRow name="bracket.ts" status="error">
					{#snippet leading()}<FileCode2 class="text-fg-tertiary" />{/snippet}
				</ListRow>
				<ListRow name="lib/fasteners.ts">
					{#snippet leading()}<FileCode2 class="text-fg-tertiary" />{/snippet}
				</ListRow>
			</div>
		</Specimen>
	</div>
</Section>

<Section id="viewport" title="Viewport chrome" description="Everything that floats over the 3D canvas. Surfaces are elevated, never opaque bars; one bottom toolbar with four tools.">
	<div class="grid grid-cols-2 gap-3">
		<Specimen title="FloatingToolbar · SelectionLabel" surface="canvas" class="col-span-2">
			<div class="flex flex-col items-center gap-5 py-3">
				<SelectionLabel value="175.2" unit="mm²" />
				<div class="flex items-center gap-4">
					<FloatingToolbar bind:tool />
					<FloatingToolbar tool="pencil" disabled={{ note: 'Save to add notes', pencil: 'Save to add notes' }}>
						{#snippet trailing()}
							<span class="flex h-8 items-center gap-1.5 px-2 text-label font-medium text-accent-fg"><span class="size-1.5 rounded-full bg-accent"></span>Unsaved preview</span>
						{/snippet}
					</FloatingToolbar>
				</div>
				<div class="flex items-center gap-2">
					<SelectionLabel value="Ø 6" unit="mm" />
					<SelectionLabel value="42.0" unit="mm" />
					<SelectionLabel value="90°" />
					<SelectionLabel value="3 faces" />
				</div>
			</div>
		</Specimen>

		<Specimen title="StatusPill" surface="canvas">
			<div class="flex flex-col items-start gap-2">
				<StatusPill tone="error" title="Bracket didn't regenerate" detail="agents notified" message="Fillet failed: radius 4 mm is larger than the adjacent 3.5 mm wall." source="bracket.ts:18" bind:expanded={pillOpen} />
				<StatusPill tone="warning" title="Slow regeneration" detail="2.4 s" message="corners (fillet) took 1.9 s. Agents can see this in list_problems." />
				<StatusPill tone="pending" title="Regenerating Lid" />
				<StatusPill tone="preview" title="Unsaved preview" detail="⌘S to save" />
			</div>
		</Specimen>

		<Specimen title="ViewportControls · ViewCube · ProgressLine" surface="canvas">
			<div class="relative flex flex-col items-end gap-2 overflow-hidden rounded-md bg-canvas p-3 shadow-[inset_0_0_0_1px_var(--border-subtle)]">
				<ProgressLine class="absolute inset-x-0 top-0" />
				<ViewCube size={60} />
				<ViewportControls />
			</div>
			<div class="flex flex-col gap-1.5">
				<span class="text-label text-fg-tertiary">Determinate · 62%</span>
				<ProgressLine value={0.62} class="rounded-full bg-active" />
			</div>
		</Specimen>
	</div>
</Section>

<Section id="states" title="Loading and empty" description="Never barren: one line of guidance, one action, the shortcut. Empty-state art is grayscale clay, the same language as the example-part renders.">
	<div class="grid grid-cols-2 gap-3">
		<Specimen title="EmptyState" note="page">
			<EmptyState title="No parts yet" shortcut={{ keys: ['mod', 'K'], label: 'Search actions' }}>
				{#snippet action()}<Button variant="primary"><Plus />Add part</Button>{/snippet}
			</EmptyState>
		</Specimen>
		<div class="flex flex-col gap-3">
			<Specimen title="EmptyState" note="panel">
				<EmptyState size="panel" title="No notes yet" shortcut={{ keys: ['C'], label: 'Add note' }} image={undefined} class="py-2" />
			</Specimen>
			<Specimen title="Skeleton">
				<div class="flex flex-col gap-2.5">
					{#each [70, 52, 84] as wv (wv)}
						<div class="flex items-center gap-2"><Skeleton class="size-3" /><Skeleton class="h-2.5" style="width:{wv}%" /></div>
					{/each}
				</div>
			</Specimen>
		</div>
	</div>
</Section>

<Section id="notes" title="Notes" description="Threads pinned to geometry. Humans and agents share one grammar; agent activity is inspectable but folded away.">
	<NoteThread
		number={12}
		status="review"
		target="Face · Bracket"
		source="bracket.ts:42"
		messages={[
			{
				author: { name: 'Maya Chen', kind: 'human', online: true },
				time: '13:48',
				body: ['Wall too thin here, needs 2 mm. Probably ', { kind: 'param', name: 'thickness' }, ' on ', { kind: 'part', name: 'bracket', color: pc('graphite') }, '.']
			},
			{
				author: { name: 'Claude Code', kind: 'agent' },
				time: '14:02',
				body: ['Raised ', { kind: 'param', name: 'thickness' }, ' from 3 to 4 mm and re-ran the fillet on ', { kind: 'entity', name: 'edge:corners[2]' }, '. Min wall is now 2.1 mm.'],
				version: { version: 14, time: '14:02', summary: 'thickness 3 → 4' },
				activity: ['edit_script bracket.ts (+2 −1)', 'regenerate · 412 ms · ok', 'measure face:inner → face:outer = 2.1 mm', 'render iso, front']
			}
		]}
	/>
</Section>

<Section id="topbar" title="Top bar" description="Document · configuration on the left, mode in the centre, presence and actions on the right.">
	<div class="overflow-hidden rounded-panel shadow-[0_0_0_1px_var(--border-subtle)]">
		<TopBar
			document="Bracket"
			configurations={[
				{ value: 'default', label: 'Default' },
				{ value: 'm3', label: 'M3' },
				{ value: 'm4', label: 'M4' }
			]}
			agents={people.filter((p) => p.kind === 'agent').slice(0, 2)}
			user={{ name: 'Jeremy Jacob', kind: 'human' }}
		/>
	</div>
</Section>
