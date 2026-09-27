<script lang="ts">
	import { Plus, Search, Focus, RotateCcw, MoreHorizontal, SlidersHorizontal } from '@lucide/svelte';
	import { partColors } from '$lib/styles/tokens';
	import { TopBar } from '$lib/components/ui/top-bar';
	import { Tabs } from '$lib/components/ui/tabs';
	import { ListRow } from '$lib/components/ui/list-row';
	import { IconButton } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Avatar } from '$lib/components/ui/avatar';
	import { Select } from '$lib/components/ui/select';
	import { NumberField, createEvaluator } from '$lib/components/ui/number-field';
	import { PropertySection, PropertyRow } from '$lib/components/ui/property';
	import { FloatingToolbar, SelectionLabel, StatusPill, ViewportControls, ViewCube } from '$lib/components/ui/viewport';

	let { theme }: { theme: 'light' | 'dark' } = $props();

	let left = $state('parts');
	let right = $state('params');
	let config = $state('m4');
	let tool = $state<'select' | 'note' | 'pencil' | 'measure'>('select');
	let thickness = $state(4);
	let width = $state(120);
	let height = $state(70);
	let fillet = $state(2.25);
	let fexpr = $state<string | undefined>('=thickness/2 + 0.25');
	let holes = $state(2);
	let lidWall = $state(1.6);

	const evaluate = createEvaluator({ scope: { width: 120, height: 70, thickness: 4 } });
	const pc = (id: string) => {
		const p = partColors.find((x) => x.id === id)!;
		return theme === 'dark' ? p.dark : p.light;
	};

	// ---- tiny isometric projector for the placeholder model
	const S = 1.8;
	const CX = 200;
	const CY = 172;
	const P = (x: number, y: number, z: number) =>
		`${(CX + (x - y) * 0.866 * S).toFixed(1)} ${(CY + ((x + y) * 0.5 - z) * S).toFixed(1)}`;
	const quad = (a: number[], b: number[], c: number[], d: number[]) =>
		`M${P(a[0], a[1], a[2])}L${P(b[0], b[1], b[2])}L${P(c[0], c[1], c[2])}L${P(d[0], d[1], d[2])}Z`;
	function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) {
		return {
			top: quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]),
			right: quad([x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [x1, y0, z0]),
			front: quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0])
		};
	}
	const base = box(0, 120, 0, 80, 0, 10);
	const wall = box(0, 120, 0, 12, 10, 70);
	const lid = box(128, 170, 30, 72, 0, 8);
	const hole = (x: number, y: number, z: number, r: number) => {
		const [hx, hy] = P(x, y, z).split(' ').map(Number);
		return { cx: hx, cy: hy, rx: r * S * 1.2247, ry: r * S * 0.7071 };
	};
	const h1 = hole(40, 50, 10, 7);
	const h2 = hole(88, 50, 10, 7);
	const wallFaceCenter = P(60, 12, 10).split(' ').map(Number);
</script>

<div class="flex h-[760px] flex-col overflow-hidden rounded-panel bg-app shadow-[0_0_0_1px_var(--border-default),0_24px_64px_-24px_rgb(0_0_0/0.25)]">
	<TopBar
		document="Bracket"
		configurations={[
			{ value: 'default', label: 'Default' },
			{ value: 'm3', label: 'M3' },
			{ value: 'm4', label: 'M4' },
			{ value: 'draft', label: 'Print-draft' }
		]}
		bind:configuration={config}
		agents={[
			{ name: 'Claude Code', kind: 'agent', status: 'working' },
			{ name: 'Codex', kind: 'agent' }
		]}
		user={{ name: 'Jeremy Jacob', kind: 'human' }}
	/>

	<div class="flex min-h-0 flex-1">
		<!-- Left: Parts -->
		<aside class="flex w-60 shrink-0 flex-col border-r border-line-subtle bg-panel">
			<Tabs
				bind:value={left}
				items={[
					{ value: 'parts', label: 'Parts' },
					{ value: 'scripts', label: 'Scripts' },
					{ value: 'history', label: 'History' }
				]}
				listClass="border-b border-line-subtle"
			/>
			<div class="px-2 pt-2">
				<Input placeholder="Filter parts" aria-label="Filter parts" size="sm">
					{#snippet leading()}<Search size={14} />{/snippet}
				</Input>
			</div>
			<div class="flex h-9 items-center justify-between pr-2 pl-4">
				<span class="text-label font-medium text-fg-secondary">4 parts</span>
				<IconButton label="Add part" size="sm"><Plus /></IconButton>
			</div>
			<div class="flex flex-col gap-px px-2" role="listbox" aria-label="Parts">
				<ListRow name="Bracket" color={pc('graphite')} selected />
				<ListRow name="Lid" color={pc('iris')} status="error">
					{#snippet actions()}<IconButton label="Isolate" size="sm"><Focus /></IconButton>{/snippet}
				</ListRow>
				<ListRow name="Gasket" color={pc('teal')} busy>
					{#snippet trailing()}<Avatar name="Claude Code" kind="agent" status="working" size={20} />{/snippet}
				</ListRow>
				<ListRow name="Hinge pin" color={pc('straw')} visible={false} />
			</div>
		</aside>

		<!-- Canvas -->
		<main
			class="relative min-w-0 flex-1 overflow-hidden bg-canvas"
			style="background-image: radial-gradient(var(--canvas-grid) 1px, transparent 1px); background-size: 16px 16px"
		>
			<div class="absolute top-3 left-3">
				<StatusPill tone="error" title="Lid didn't regenerate" detail="agents notified" message="Shell failed on face:inner." source="lid.ts:22" />
			</div>
			<div class="absolute top-3 right-3 flex flex-col items-end gap-2">
				<ViewCube size={64} />
				<ViewportControls />
			</div>

			<div class="absolute inset-0 grid place-items-center">
				<div class="relative">
					<svg viewBox="0 0 480 440" width="480" height="440" aria-label="Bracket (placeholder render)" role="img">
						<defs>
							<filter id="ws-shadow-{theme}" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="10" /></filter>
						</defs>
						<ellipse cx="244" cy="372" rx="160" ry="22" fill="rgb(0 0 0 / {theme === 'dark' ? 0.45 : 0.12})" filter="url(#ws-shadow-{theme})" />
						{#each [{ b: base, c: 'var(--part-graphite)' }, { b: wall, c: 'var(--part-graphite)' }, { b: lid, c: 'var(--part-iris)' }] as item, i (i)}
							<g stroke="rgb(0 0 0 / {theme === 'dark' ? 0.55 : 0.42})" stroke-width="1" stroke-linejoin="round">
								<path d={item.b.front} fill="color-mix(in oklab, {item.c}, black 4%)" />
								<path d={item.b.right} fill="color-mix(in oklab, {item.c}, black 22%)" />
								<path d={item.b.top} fill="color-mix(in oklab, {item.c}, white 22%)" />
							</g>
							{#if i === 0}
								{#each [h1, h2] as hh, j (j)}
									<ellipse cx={hh.cx} cy={hh.cy} rx={hh.rx} ry={hh.ry} fill="color-mix(in oklab, var(--part-graphite), black 45%)" stroke="rgb(0 0 0 / 0.45)" />
								{/each}
							{/if}
						{/each}
						<!-- selected face: translucent orange fill + stroke -->
						<path d={wall.front} fill="var(--selection-selected-fill)" stroke="var(--selection-selected-stroke)" stroke-width="2" stroke-linejoin="round" />
						<!-- preselect on the lid top -->
						<path d={lid.top} fill="none" stroke="var(--selection-preselect)" stroke-width="1.75" stroke-linejoin="round" />
					</svg>
					<SelectionLabel value="7,200" unit="mm²" class="absolute -translate-x-1/2" style="left:{wallFaceCenter[0]}px; top:{wallFaceCenter[1] + 10}px" />
				</div>
			</div>

			<div class="absolute inset-x-0 bottom-4 flex justify-center">
				<FloatingToolbar bind:tool />
			</div>
		</main>

		<!-- Right: Params -->
		<aside class="flex w-68 shrink-0 flex-col border-l border-line-subtle bg-panel">
			<Tabs
				bind:value={right}
				items={[
					{ value: 'properties', label: 'Properties' },
					{ value: 'params', label: 'Params' },
					{ value: 'notes', label: 'Notes', count: 3 }
				]}
				listClass="border-b border-line-subtle"
			/>
			<div class="min-h-0 flex-1 overflow-y-auto">
				<PropertySection title="Configuration">
					{#snippet actions()}<IconButton label="Configuration options" size="sm"><MoreHorizontal /></IconButton>{/snippet}
					<Select
						aria-label="Configuration"
						bind:value={config}
						items={[
							{ value: 'default', label: 'Default', hint: 'code' },
							{ value: 'm3', label: 'M3', hint: '2' },
							{ value: 'm4', label: 'M4', hint: '3' },
							{ value: 'draft', label: 'Print-draft', hint: '5' }
						]}
						icon={SlidersHorizontal}
					/>
				</PropertySection>
				<PropertySection title="Bracket" collapsible meta="3 overrides">
					{#snippet actions()}<IconButton label="Reset all" size="sm"><RotateCcw size={14} /></IconButton>{/snippet}
					<PropertyRow label="thickness" layout="inline" overridden hint="Default 3 mm · bracket.ts:12">
						<NumberField bind:value={thickness} defaultValue={3} source="bracket.ts:12" unit="mm" min={1} max={10} step={0.5} {evaluate} aria-label="thickness" />
					</PropertyRow>
					<PropertyRow label="width" layout="inline">
						<NumberField bind:value={width} defaultValue={120} unit="mm" min={40} max={300} {evaluate} aria-label="width" />
					</PropertyRow>
					<PropertyRow label="height" layout="inline" overridden hint="Default 60 mm · bracket.ts:14">
						<NumberField bind:value={height} defaultValue={60} source="bracket.ts:14" unit="mm" min={20} max={200} {evaluate} aria-label="height" />
					</PropertyRow>
					<PropertyRow label="fillet_radius" layout="inline" overridden hint="Default 2 mm · bracket.ts:18">
						<NumberField bind:value={fillet} bind:expression={fexpr} defaultValue={2} source="bracket.ts:18" unit="mm" min={0} step={0.25} {evaluate} aria-label="fillet_radius" />
					</PropertyRow>
					<PropertyRow label="hole_count" layout="inline">
						<NumberField bind:value={holes} defaultValue={2} min={1} max={8} step={1} precision={0} aria-label="hole_count" />
					</PropertyRow>
				</PropertySection>
				<PropertySection title="Lid" collapsible>
					<PropertyRow label="wall" layout="inline">
						<NumberField bind:value={lidWall} defaultValue={1.6} unit="mm" min={0.8} max={4} step={0.1} aria-label="wall" />
					</PropertyRow>
				</PropertySection>
				<PropertySection title="Gasket" collapsible open={false} meta="2 params" />
			</div>
		</aside>
	</div>
</div>
