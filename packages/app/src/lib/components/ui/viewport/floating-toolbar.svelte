<script lang="ts" module>
	export type Tool = 'select' | 'note' | 'pencil' | 'measure';
</script>

<script lang="ts">
	import { MousePointer2, MessageCircle, Pencil, Ruler } from '@lucide/svelte';
	import type { LucideIcon } from '@lucide/svelte';
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';
	import { Tooltip } from '$lib/components/ui/tooltip';

	type Props = {
		tool?: Tool;
		/** Tools that are unavailable, with the reason shown in the tooltip. */
		disabled?: Partial<Record<Tool, string>>;
		/** The tools to offer (default all), e.g. no note or pencil for a view-only document. */
		only?: Tool[];
		/** Bind V / C / P / M globally (ignored while typing in a field). */
		hotkeys?: boolean;
		/** Extra trailing content after a divider (e.g. an "Unsaved preview" chip). */
		trailing?: Snippet;
		class?: string;
		onToolChange?: (t: Tool) => void;
	};
	let { tool = $bindable('select'), disabled = {}, only, hotkeys = false, trailing, class: className, onToolChange }: Props =
		$props();

	const allTools: { id: Tool; label: string; key: string; icon: LucideIcon }[] = [
		{ id: 'select', label: 'Select', key: 'V', icon: MousePointer2 },
		{ id: 'note', label: 'Note', key: 'C', icon: MessageCircle },
		{ id: 'pencil', label: 'Pencil', key: 'P', icon: Pencil },
		{ id: 'measure', label: 'Measure', key: 'M', icon: Ruler }
	];
	const tools = $derived(only ? allTools.filter((t) => only.includes(t.id)) : allTools);

	const activeIndex = $derived(tools.findIndex((x) => x.id === tool && !disabled[x.id]));

	function pick(t: Tool) {
		if (disabled[t]) return;
		tool = t;
		onToolChange?.(t);
	}

	function onkey(e: KeyboardEvent) {
		if (!hotkeys || e.metaKey || e.ctrlKey || e.altKey) return;
		const el = e.target as HTMLElement | null;
		if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
		const t = tools.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
		if (t) {
			e.preventDefault();
			pick(t.id);
		}
	}
</script>

<svelte:window onkeydown={onkey} />

<!--
	Concentric: surface radius 12, padding 4 → 32px tool buttons with radius 8.
	The active fill is one element that slides between tools (Figma style); tools are a fixed
	32px + 2px gap, so its offset is index × 34px. The tool itself switches instantly.
-->
<div
	role="toolbar"
	aria-label="Tools"
	aria-orientation="horizontal"
	class={cn(
		'relative isolate inline-flex items-center gap-0.5 rounded-[var(--toolbar-radius)] bg-elevated p-[var(--toolbar-pad)] shadow-toolbar',
		className
	)}
>
	{#if activeIndex >= 0}
		<span
			aria-hidden="true"
			class="absolute top-[var(--toolbar-pad)] left-[var(--toolbar-pad)] -z-10 size-8 rounded-[var(--toolbar-item-radius)] bg-accent transition-transform duration-[var(--duration-base)] ease-out"
			style="transform: translateX({activeIndex * 34}px)"
		></span>
	{/if}
	{#each tools as t (t.id)}
		<Tooltip label={disabled[t.id] ?? t.label} shortcut={disabled[t.id] ? undefined : [t.key]} sideOffset={10}>
			{#snippet trigger(props)}
				<button
					{...props}
					type="button"
					aria-label={t.label}
					aria-pressed={tool === t.id}
					aria-disabled={!!disabled[t.id] || undefined}
					onclick={() => pick(t.id)}
					class={cn(
						'inline-flex size-8 items-center justify-center rounded-[var(--toolbar-item-radius)] focus-ring transition-colors-fast',
						tool === t.id
							? 'text-fg-on-accent'
							: 'text-fg-secondary hover:bg-hover hover:text-fg',
						disabled[t.id] && 'text-fg-disabled hover:bg-transparent hover:text-fg-disabled'
					)}
				>
					<t.icon />
				</button>
			{/snippet}
		</Tooltip>
	{/each}
	{#if trailing}
		<span class="mx-1 h-5 w-px bg-line" aria-hidden="true"></span>
		{@render trailing()}
	{/if}
</div>
