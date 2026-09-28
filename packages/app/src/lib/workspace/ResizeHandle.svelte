<script lang="ts">
	// Drag handle on a sidebar's inner edge. `side` is which sidebar it belongs to: dragging toward the
	// viewport grows it. Double-click resets to the default width (width = null).
	import { cn } from '$lib/utils';

	let {
		side,
		width = $bindable(),
		min = 200,
		max = 560,
		label
	}: { side: 'left' | 'right'; width: number | null; min?: number; max?: number; label: string } = $props();

	let el: HTMLDivElement;
	let dragging = $state(false);
	let startX = 0;
	let startW = 0;

	const clamp = (w: number) => Math.round(Math.min(max, Math.max(min, w)));

	function down(e: PointerEvent) {
		if (e.button !== 0) return;
		e.preventDefault();
		startX = e.clientX;
		startW = el.parentElement!.getBoundingClientRect().width;
		dragging = true;
		el.setPointerCapture(e.pointerId);
	}
	function move(e: PointerEvent) {
		if (!dragging) return;
		const dx = e.clientX - startX;
		width = clamp(startW + (side === 'left' ? dx : -dx));
	}
	function up(e: PointerEvent) {
		dragging = false;
		if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
	}
	function key(e: KeyboardEvent) {
		const step = e.shiftKey ? 32 : 8;
		const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft';
		const shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
		if (e.key !== grow && e.key !== shrink) return;
		e.preventDefault();
		const cur = width ?? el.parentElement!.getBoundingClientRect().width;
		width = clamp(cur + (e.key === grow ? step : -step));
	}
</script>

<!-- a focusable separator is the ARIA window-splitter pattern -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
	bind:this={el}
	role="separator"
	aria-orientation="vertical"
	aria-label={label}
	aria-valuemin={min}
	aria-valuemax={max}
	aria-valuenow={width ?? undefined}
	tabindex="0"
	class={cn('group absolute inset-y-0 z-30 w-2 cursor-col-resize touch-none outline-none', side === 'left' ? '-right-1' : '-left-1')}
	onpointerdown={down}
	onpointermove={move}
	onpointerup={up}
	onpointercancel={up}
	ondblclick={() => (width = null)}
	onkeydown={key}
	data-testid="resize-{side}"
>
	<div class={cn('pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-accent opacity-0 transition-opacity delay-100 duration-150 group-hover:opacity-100 group-focus-visible:opacity-100', dragging && 'opacity-100 delay-0')}></div>
</div>
