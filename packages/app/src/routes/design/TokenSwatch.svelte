<script lang="ts">
	import { cn } from '$lib/utils';
	type Props = { name: string; label?: string; kind?: 'fill' | 'text' | 'line'; class?: string };
	let { name, label, kind = 'fill', class: className }: Props = $props();

	let el: HTMLDivElement | undefined = $state();
	let value = $state('');
	$effect(() => {
		if (!el) return;
		// Re-read when the root theme flips (panes force their own theme, but "system" may change).
		const read = () => (value = getComputedStyle(el!).getPropertyValue(name).trim());
		read();
		const mo = new MutationObserver(read);
		mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
		return () => mo.disconnect();
	});
	// "rgb(20 20 30 / 0.045)" → "#14141e 4.5%" so values fit under a swatch.
	const short = $derived.by(() => {
		const m = /^rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)\s*[/,]\s*([\d.]+)\)$/.exec(value);
		if (!m) return value;
		const hex = [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
		return `#${hex} ${+(Number(m[4]) * 100).toFixed(1)}%`;
	});
</script>

<div bind:this={el} class={cn('flex min-w-0 flex-col gap-1.5', className)}>
	<div
		class="relative h-10 overflow-hidden rounded-md shadow-[inset_0_0_0_1px_var(--border-default)]"
		style={kind === 'fill'
			? `background: repeating-conic-gradient(var(--bg-input) 0 25%, var(--bg-panel) 0 50%) 0 0 / 8px 8px`
			: 'background: var(--bg-panel)'}
	>
		{#if kind === 'fill'}
			<div class="absolute inset-0" style="background: var({name})"></div>
		{:else if kind === 'text'}
			<div class="absolute inset-0 grid place-items-center text-title font-heading font-medium" style="color: var({name})">
				Aa
			</div>
		{:else}
			<div class="absolute inset-2 rounded-sm" style="box-shadow: inset 0 0 0 1.5px var({name})"></div>
		{/if}
		<div class="pointer-events-none absolute inset-0 rounded-md shadow-[inset_0_0_0_1px_var(--border-default)]"></div>
	</div>
	<div class="flex min-w-0 flex-col">
		<span class="text-label font-medium text-fg [overflow-wrap:anywhere]">{label ?? name.replace(/^--/, '')}</span>
		<span class="truncate font-mono text-caption text-fg-tertiary" title={value}>{short || '—'}</span>
	</div>
</div>
