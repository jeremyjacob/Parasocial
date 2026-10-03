<script lang="ts">
	import { Copy, ArrowUpRight, SlidersHorizontal, RotateCw, MoveHorizontal, Cylinder, Move, Orbit, Link2 } from '@lucide/svelte';
	import { PropertySection } from '$lib/components/ui/property';
	import { Input } from '$lib/components/ui/input';
	import { Select } from '$lib/components/ui/select';
	import { IconButton } from '$lib/components/ui/button';
	import { ColorSwatch } from '$lib/components/ui/color-swatch';
	import { NumberField } from '$lib/components/ui/number-field';
	import { Switch } from '$lib/components/ui/switch';
	import { toast } from '$lib/components/ui/toast';
	import { mutators } from '@parasocial/sync';
	import { sourcePart, type AssemblyJoint, type EntityDescription } from '@parasocial/runtime/protocol';
	import { withinScope } from '@parasocial/runtime/assembly-scope';
	import { theme } from '$lib/theme.svelte';
	import { num } from '$lib/format';
	import type { WorkspaceState } from './state.svelte';

	let { ws }: { ws: WorkspaceState } = $props();

	const sel = $derived(ws.selection);
	const one = $derived(sel.length === 1 ? sel[0] : null);
	let desc = $state.raw<EntityDescription | null>(null);
	let descFor: string | null = null;

	$effect(() => {
		const s = one;
		const ready = ws.kernelReady;
		const key = s ? `${s.part}:${s.kind}:${s.index}:${ws.results[s.part]?.key}` : null;
		if (!s || s.kind === ('part' as any) || !ready || !ws.engine) {
			desc = null;
			return;
		}
		if (key === descFor) return;
		descFor = key;
		ws.engine.describe(s.part, s.kind, s.index).then(
			(d) => descFor === key && (desc = d),
			() => {}
		);
	});

	const row = 'grid min-h-6 grid-cols-[88px_minmax(0,1fr)] items-center gap-2 text-ui';

	// auto hand-off: open notes go to the built-in agent, on the provider of whoever switched it on
	const agentAuto = $derived((ws.doc?.settings as { agent?: { autoHandoff?: boolean; runAs?: string } } | undefined)?.agent);
	let autoHandoff = $state(false);
	$effect(() => {
		autoHandoff = !!agentAuto?.autoHandoff;
	});
	function setAutoHandoff(enabled: boolean) {
		if (enabled && !ws.agentConfigured) {
			autoHandoff = false;
			toast.error('Add an API key to use the built-in agent', { action: { label: 'Settings', onClick: () => (location.href = '/settings#agent') } });
			return;
		}
		ws.zero.mutate(mutators.document.setAgentAutoHandoff({ id: ws.documentID, enabled }));
	}
	const vec = (v?: number[]) => (v ? `(${v.map((x) => num(x, 3)).join(', ')})` : '—');
	const typeName: Record<string, string> = { plane: 'Planar face', cylinder: 'Cylindrical face', cone: 'Conical face', sphere: 'Spherical face', torus: 'Toroidal face', bspline: 'Freeform face', line: 'Line edge', circle: 'Circular edge', ellipse: 'Elliptical edge', bspline_edge: 'Spline edge' };

	async function copy(text: string) {
		await navigator.clipboard.writeText(text);
		toast('Copied');
	}

	function reveal(file?: string, line?: number) {
		if (!file) return;
		ws.openScript = file;
		ws.revealLine = line ?? null;
		ws.mode = 'code';
	}

	const JOINT_ICON = { revolute: RotateCw, slider: MoveHorizontal, cylindrical: Cylinder, planar: Move, ball: Orbit, fastened: Link2 } as const;
	const JOINT_LABEL = { revolute: 'Revolute', slider: 'Slider', cylindrical: 'Cylindrical', planar: 'Planar', ball: 'Ball', fastened: 'Fastened' } as const;
	/** Each of a joint's values: short label and unit (degrees, millimetres from where the parts are modeled). Ball joints aren't edited here. */
	const DOF: Record<string, { label?: string; unit: '°' | 'mm' }[]> = {
		revolute: [{ unit: '°' }],
		slider: [{ unit: 'mm' }],
		cylindrical: [{ label: 'θ', unit: '°' }, { label: 'd', unit: 'mm' }],
		planar: [{ label: 'X', unit: 'mm' }, { label: 'Y', unit: 'mm' }, { label: 'θ', unit: '°' }]
	};
	const partName = (id: string) => ws.results[id]?.name ?? ws.partInfos.find((p) => p.id === sourcePart(id))?.name ?? id;
	// a joint named inside an inserted assembly is saved as "corner@left/spin": shown "Corner left › Spin"
	const jointName = (j: AssemblyJoint) => {
		if (!j.named) return `${partName(j.a)} – ${partName(j.b)}`;
		const scope = ws.scopeLabel(j.scope);
		// assembly ids have no "/": the name starts with the scope below the assembly, then "/"
		const own = scope ? j.name.slice(j.scope.length - j.scope.indexOf('/')) : j.name;
		const cap = own[0].toUpperCase() + own.slice(1);
		if (selectedScope) {
			const selectedLabel = ws.scopeLabel(selectedScope.id);
			const relative = selectedLabel && scope?.startsWith(`${selectedLabel} › `) ? scope.slice(selectedLabel.length + 3) : scope;
			return j.scope === selectedScope.id || !relative ? cap : `${cap} · ${relative}`;
		}
		return scope ? `${scope} › ${cap}` : cap;
	};

	/** The studio in the viewport: its problems, and the joints that drive its assemblies (followers around a closed loop, and fastened joints, stay out). */
	const studio = $derived(ws.studio);
	const selectedScope = $derived(ws.selectedAssemblyScope);
	const assemblies = $derived(selectedScope ? [selectedScope.assembly] : studio?.assemblies ?? []);
	/** The selected copy's assembly definition, else the studio's one assembly: its options (description, part number). */
	const definition = $derived(selectedScope ? ws.asm.assemblies.find((a) => a.id === selectedScope.definition) : studio?.assemblies.length === 1 ? studio.assemblies[0] : undefined);
	const description = $derived(selectedScope ? definition?.description : studio?.description);
	const inScope = (scope: string) => !selectedScope || withinScope(scope, selectedScope.id);
	const detailIDs = $derived(selectedScope ? selectedScope.instances.map((i) => i.id) : studio?.ids ?? []);
	const detailFile = $derived(selectedScope ? ws.asm.assemblies.find((a) => a.id === selectedScope.definition)?.file : studio?.file);
	const joints = $derived(
		assemblies.flatMap((a) =>
			a.joints.filter((j) => inScope(j.scope) && (ws.asm.drivers[a.id]?.includes(j.name) ?? j.type !== 'fastened')).map((j) => ({ asm: a.id, joint: j, name: jointName(j), value: ws.asm.values[a.id]?.[j.name] ?? j.value }))
		)
	);
	/** Joints tied together (gear, rack and pinion, screw): the follower moves with its driver, so only drivers have fields above. */
	const RELATION_LABEL = { gear: 'Gear', rackPinion: 'Rack and pinion', screw: 'Screw', linear: 'Linear' } as const;
	const relations = $derived(
		assemblies.flatMap((a) =>
			(a.relations ?? []).filter((r) => inScope(r.scope)).map((r) => {
				const named = (n: string) => {
					const j = a.joints.find((x) => x.name === n);
					return j ? jointName(j) : n;
				};
				const perTurn = `${num(r.ratio * 360, 3)} mm/turn`;
				const how = r.kind === 'gear' ? `${num(r.ratio, 4)}×` : r.kind === 'linear' ? `${num(r.ratio, 4)}×${r.offset ? ` ${r.offset > 0 ? '+' : '−'} ${num(Math.abs(r.offset), 3)}` : ''}` : perTurn;
				return { key: `${a.id}/${r.a}:${r.ia}/${r.b}:${r.ib}`, label: RELATION_LABEL[r.kind], joints: r.a === r.b ? named(r.a) : `${named(r.a)} → ${named(r.b)}`, how, source: r.source };
			})
		)
	);
	const problems = $derived.by(() => {
		if (!studio) return [];
		const asm = ws.asm.problems.filter((p) => assemblies.some((a) => a.id === p.assembly)).map((p) => p.message);
		const parts = detailIDs.flatMap((id) => (ws.results[id]?.problems ?? []).filter((p) => p.severity === 'error' || p.severity === 'warning').map((p) => `${partName(id)}: ${p.message}`));
		return [...new Set([...asm, ...parts])];
	});
	const withValue = (v: number[], i: number, x: number) => v.map((y, k) => (k === i ? x : y));

	let docName = $state('');
	$effect(() => {
		docName = ws.doc?.name ?? '';
	});
	function rename() {
		const n = docName.trim();
		if (n && ws.doc && n !== ws.doc.name) ws.zero.mutate(mutators.document.rename({ id: ws.documentID, name: n }));
	}
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-auto" data-testid="properties-panel">
	{#if !sel.length || selectedScope}
		{#if studio}
			<PropertySection bodyClass="gap-0.5" title={selectedScope?.name ?? studio.name} meta={selectedScope ? selectedScope.id === selectedScope.assembly.id ? 'Assembly' : 'Subassembly' : studio.assemblies.length ? 'Assembly' : 'Studio'}>
				{#if description}<p class="pb-1.5 text-ui text-fg-secondary" data-testid="studio-description">{description}</p>{/if}
				{#if definition?.partNumber}<div class={row}><span class="text-fg-secondary">Part number</span><span class="truncate tabular-nums">{definition.partNumber}</span></div>{/if}
				<div class={row}><span class="text-fg-secondary">Script</span><button class="focus-ring flex items-center gap-1 truncate rounded-xs text-left text-accent hover:underline" onclick={() => reveal(detailFile)}>{detailFile} <ArrowUpRight size={12} /></button></div>
				<div class={row}><span class="text-fg-secondary">Parts</span><span class="tabular-nums">{detailIDs.length}</span></div>
				{#if studio.assemblies.length}
					<div class={row}><span class="text-fg-secondary">Joints</span><span class="tabular-nums">{assemblies.reduce((n, a) => n + a.joints.filter((j) => inScope(j.scope)).length, 0)}</span></div>
					<div class={row}><span class="text-fg-secondary">Subassemblies</span><span class="tabular-nums">{selectedScope ? selectedScope.subs.length : assemblies.reduce((n, a) => n + a.subs.length, 0)}</span></div>
				{/if}
				{#each problems as p (p)}
					<p class="py-0.5 text-ui text-error" data-testid="studio-problem">{p}</p>
				{/each}
			</PropertySection>
			{#if joints.length}
				<PropertySection bodyClass="gap-1" title="Joints" meta={String(joints.length)}>
					{#each joints as j (`${j.asm}/${j.joint.name}`)}
						{@const dof = DOF[j.joint.type]}
						<div class="grid min-h-7 grid-cols-[88px_minmax(0,1fr)] items-center gap-2 text-ui" data-joint={j.joint.name}>
							<span class="truncate text-fg-secondary" title="{JOINT_LABEL[j.joint.type]} · {partName(j.joint.a)} – {partName(j.joint.b)}">{j.name}</span>
							{#if dof}
								<span class="flex min-w-0 gap-1">
									{#each dof as d, i (i)}
										{@const lim = j.joint.limits[i]}
										<NumberField
											size="sm"
											class="min-w-0 flex-1"
											icon={dof.length === 1 ? JOINT_ICON[j.joint.type] : undefined}
											label={d.label}
											unit={d.unit}
											value={j.value[i] ?? 0}
											defaultValue={j.joint.value[i] ?? 0}
											min={lim?.min}
											max={lim?.max}
											step={1}
											precision={d.unit === '°' ? 1 : 2}
											aria-label={d.label ? `${j.name} ${d.label}` : j.name}
											oninput={(x) => ws.asm.setJoint(j.asm, j.joint.name, withValue(j.value, i, x))}
											oncommit={(x) => ws.asm.commitJoint(j.asm, j.joint.name, withValue(j.value, i, x), j.name)}
										/>
									{/each}
								</span>
							{:else}
								<span class="tabular-nums text-fg-tertiary">{num(Math.hypot(...j.value), 1)}°</span>
							{/if}
						</div>
					{/each}
				</PropertySection>
			{/if}
			{#if relations.length}
				<PropertySection bodyClass="gap-0.5" title="Relations" meta={String(relations.length)}>
					{#each relations as r (r.key)}
						<div class={row} data-relation={r.key}>
							<span class="truncate text-fg-secondary">{r.label}</span>
							<button class="focus-ring flex min-w-0 items-center justify-between gap-2 rounded-xs text-left hover:underline" title="{r.joints} · {r.how}" onclick={() => reveal(r.source?.file, r.source?.line)}>
								<span class="truncate">{r.joints}</span><span class="shrink-0 tabular-nums text-fg-tertiary">{r.how}</span>
							</button>
						</div>
					{/each}
				</PropertySection>
			{/if}
		{/if}
		<PropertySection bodyClass="gap-0.5" title="Document">
			{#if ws.readOnly}
				<div class={row}><span class="text-fg-secondary">Name</span><span class="truncate">{ws.doc?.name}</span></div>
				<div class={row}><span class="text-fg-secondary">Units</span><span>{ws.doc?.units === 'in' ? 'Inches' : 'Millimeters'}</span></div>
				<div class={row}><span class="text-fg-secondary">Access</span><span>View only</span></div>
			{:else}
				<label class={row}>
					<span class="text-fg-secondary">Name</span>
					<Input size="sm" bind:value={docName} onblur={rename} onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()} />
				</label>
				<div class={row}>
					<span class="text-fg-secondary">Units</span>
					<Select size="sm" items={[{ value: 'mm', label: 'Millimeters' }, { value: 'in', label: 'Inches' }]} value={ws.doc?.units ?? 'mm'} onValueChange={(v) => ws.zero.mutate(mutators.document.updateSettings({ id: ws.documentID, units: v } as any))} />
				</div>
				<div class={row} title={agentAuto?.autoHandoff && agentAuto.runAs !== ws.userID ? "Hand every open note to the agent (runs on a teammate's provider)" : 'Hand every open note to the agent'}>
					<label for="agent-pickup" class="text-fg-secondary">Agent pickup</label>
					<Switch id="agent-pickup" bind:checked={autoHandoff} onCheckedChange={setAutoHandoff} class="h-6" />
				</div>
			{/if}
			<div class={row}><span class="text-fg-secondary">Parts</span><span class="tabular-nums">{ws.parts.length}</span></div>
			<div class={row}><span class="text-fg-secondary">Version</span><span class="tabular-nums">v{ws.doc?.headVersion ?? 0}</span></div>
		</PropertySection>
		<!-- <p class="px-4 py-3 text-label text-fg-tertiary">Select a face, edge or part.</p> -->
	{:else if one && one.kind === ('part' as any)}
		{@const r = ws.results[one.part]}
		{#if r}
			<PropertySection bodyClass="gap-0.5" title={r.name}>
				<div class={row}>
					<span class="text-fg-secondary">Color</span>
					<span class="flex items-center gap-2"><ColorSwatch color={ws.partColor(one.part, theme.resolved === 'dark')} size={14} /> <span class="text-fg-secondary">{r.color?.kind === 'rgb' ? r.color.hex : 'Auto'}</span></span>
				</div>
				{#if r.appearance?.opacity !== undefined && r.appearance.opacity < 1}
					<div class={row}><span class="text-fg-secondary">Opacity</span><span class="tabular-nums">{Math.round(r.appearance.opacity * 100)}%</span></div>
				{/if}
				{#if r.appearance?.roughness !== undefined || r.appearance?.metalness !== undefined}
					<div class={row}>
						<span class="text-fg-secondary">Finish</span>
						<span class="tabular-nums">{[r.appearance.metalness !== undefined && `metalness ${num(r.appearance.metalness, 2)}`, r.appearance.roughness !== undefined && `roughness ${num(r.appearance.roughness, 2)}`].filter(Boolean).join(' · ')}</span>
					</div>
				{/if}
				<div class={row}><span class="text-fg-secondary">Material</span><span>{r.material?.name ?? (r.material?.density ? `${r.material.density} g/cm³` : 'None')}</span></div>
				<div class={row}><span class="text-fg-secondary">Script</span><button class="focus-ring flex items-center gap-1 truncate rounded-xs text-left text-accent hover:underline" onclick={() => reveal(r.file)}>{r.file} <ArrowUpRight size={12} /></button></div>
			</PropertySection>
			{#if r.mass}
				<PropertySection bodyClass="gap-0.5" title="Mass properties">
					<div class={row}><span class="text-fg-secondary">Volume</span><span class="tabular-nums">{num(r.mass.volume, 1)} mm³</span></div>
					<div class={row}><span class="text-fg-secondary">Mass</span><span class="tabular-nums">{num(r.mass.mass, 2)} g</span></div>
					<div class={row}><span class="text-fg-secondary">Surface</span><span class="tabular-nums">{num(r.mass.area, 1)} mm²</span></div>
					<div class={row}><span class="text-fg-secondary">Center</span><span class="truncate tabular-nums">{vec(r.mass.centroid)}</span></div>
				</PropertySection>
			{/if}
			{#if r.bbox}
				<PropertySection bodyClass="gap-0.5" title="Bounding box">
					{@const size = r.bbox.max.map((v, i) => v - r.bbox!.min[i])}
					<div class={row}><span class="text-fg-secondary">Size</span><span class="tabular-nums">{size.map((v) => num(v, 2)).join(' × ')} mm</span></div>
				</PropertySection>
			{/if}
			{#if r.params.length}
				<button class="focus-ring mx-4 my-3 flex items-center gap-1.5 rounded-xs text-ui text-accent hover:underline" onclick={() => (ws.rightTab = 'params')}><SlidersHorizontal size={14} /> {r.params.length} param{r.params.length === 1 ? '' : 's'}</button>
			{/if}
		{/if}
	{:else if one}
		{@const r = ws.results[one.part]}
		{@const f = one.kind === 'face' ? r?.faces[one.index] : null}
		{@const e = one.kind === 'edge' ? r?.edges[one.index] : null}
		{@const name = desc?.name ?? r?.names?.[one.kind as 'face' | 'edge']?.[one.index]}
		<PropertySection bodyClass="gap-0.5" title={f ? (typeName[f.surface] ?? 'Face') : e ? (typeName[e.curve === 'bspline' ? 'bspline_edge' : e.curve] ?? 'Edge') : 'Vertex'} meta={r?.name}>
			{#if f}
				<div class={row}><span class="text-fg-secondary">Area</span><span class="tabular-nums">{num(f.area, 3)} mm²</span></div>
				{#if f.surface === 'plane'}<div class={row}><span class="text-fg-secondary">Normal</span><span class="tabular-nums">{vec(f.normal)}</span></div>{/if}
				{#if f.radius}<div class={row}><span class="text-fg-secondary">Radius</span><span class="tabular-nums">{num(f.radius, 3)} mm</span></div>{/if}
				{#if f.axis}<div class={row}><span class="text-fg-secondary">Axis</span><span class="tabular-nums">{vec(f.axis)}</span></div>{/if}
			{:else if e}
				<div class={row}><span class="text-fg-secondary">Length</span><span class="tabular-nums">{num(e.length, 3)} mm</span></div>
				{#if e.radius}<div class={row}><span class="text-fg-secondary">Radius</span><span class="tabular-nums">{num(e.radius, 3)} mm</span></div>{/if}
				{#if e.direction}<div class={row}><span class="text-fg-secondary">Direction</span><span class="tabular-nums">{vec(e.direction)}</span></div>{/if}
			{/if}
		</PropertySection>
		<PropertySection bodyClass="gap-0.5" title="Reference">
			<div class={row}>
				<span class="text-fg-secondary">Name</span>
				<span class="flex min-w-0 items-center gap-1">
					<code class="min-w-0 flex-1 truncate font-mono text-label" title={name} data-testid="stable-name">{name ?? (ws.kernelReady ? '…' : 'Loading…')}</code>
					{#if name}<IconButton label="Copy reference" size="sm" onclick={() => copy(name)}><Copy /></IconButton>{/if}
				</span>
			</div>
			{#if desc?.createdBy}
				{@const cb = desc.createdBy}
				<div class={row}>
					<span class="text-fg-secondary">Feature</span>
					<span class="truncate"><span class="font-mono text-label">{cb.tag ?? cb.id.split('/').pop()}</span> <span class="text-fg-tertiary">{cb.type}</span></span>
				</div>
				{#if cb.source}
					<div class={row}>
						<span class="text-fg-secondary">Source</span>
						<span class="flex min-w-0 flex-wrap items-center gap-x-1 text-label">
							{#each [...(cb.chain?.slice(0, -1) ?? []), cb.source] as c, i (i)}
								{#if i}<span class="text-fg-tertiary">→</span>{/if}
								<button class="focus-ring inline-flex items-center gap-0.5 rounded-xs text-accent hover:underline" onclick={() => reveal(c.file, c.line)} data-testid={c === cb.source ? 'created-by-source' : undefined}>{c.file.split('/').pop()}:{c.line}</button>
							{/each}
						</span>
					</div>
				{/if}
			{/if}
		</PropertySection>
		{#if desc?.neighbors?.length}
			<PropertySection bodyClass="gap-0.5" title="Touches" meta={String(desc.neighbors.length)}>
				<ul class="flex flex-col gap-1">
					{#each desc.neighbors as n (n)}<li class="truncate font-mono text-label text-fg-secondary" title={n}>{n}</li>{/each}
				</ul>
			</PropertySection>
		{/if}
	{:else}
		<PropertySection bodyClass="gap-0.5" title="{sel.length} selected">
			<p class="text-ui text-fg-secondary">{[...new Set(sel.map((s) => s.kind))].map((k) => `${sel.filter((s) => s.kind === k).length} ${k}${sel.filter((s) => s.kind === k).length === 1 ? '' : 's'}`).join(', ')}{new Set(sel.map((s) => s.part)).size > 1 ? ` · ${new Set(sel.map((s) => s.part)).size} parts` : ''}</p>
		</PropertySection>
	{/if}
</div>
