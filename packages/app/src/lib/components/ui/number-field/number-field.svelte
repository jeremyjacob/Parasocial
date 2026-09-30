<script lang="ts">
	import { onDestroy } from 'svelte';
	import { startScrub, scrubCursor } from './scrub';
	import type { LucideIcon } from '@lucide/svelte';
	import { RotateCcw } from '@lucide/svelte';
	import { cn } from '$lib/utils';
	import { Tooltip } from '$lib/components/ui/tooltip';
	import {
		clamp,
		createEvaluator,
		decimalsOf,
		formatNumber,
		roundTo,
		type Evaluator
	} from './evaluate';

	type Props = {
		/** Evaluated numeric value, in the field's unit. */
		value: number;
		/** The expression as typed ("=width/2", "1/4 in"), when the value came from one. */
		expression?: string;
		/** Full-width row label outside the field (params panel); also the scrub handle. */
		rowLabel?: string;
		/** Identifier behind the row label, shown in its tooltip ("ropeD"), for expressions. */
		rowName?: string;
		/** Short leading label (Figma's "W", "X") — drag it to scrub. */
		label?: string;
		/** Leading icon instead of a letter (also a scrub handle). */
		icon?: LucideIcon;
		/** Unit suffix shown quietly after the value. */
		unit?: string;
		min?: number;
		max?: number;
		step?: number;
		/** Shift multiplies the step by this (coarse). */
		coarse?: number;
		/** Alt multiplies the step by this (fine). */
		fine?: number;
		/** Max decimals shown. Defaults to max(step decimals + 1, 2) so fine steps stay visible. */
		precision?: number;
		/** Pixels of drag per step while scrubbing. */
		pixelsPerStep?: number;
		/** Parses typed text. Swap in a document-aware evaluator for params/units. */
		evaluate?: Evaluator;
		/** Code default; when set and value differs, the field is "overridden". */
		defaultValue?: number;
		/** Force the overridden state (e.g. a config override equal to the default). */
		overridden?: boolean;
		/** Where the default is declared, for the reset tooltip ("bracket.ts:12"). */
		source?: string;
		/** Externally supplied error (e.g. the server rejected it). */
		error?: string;
		disabled?: boolean;
		size?: 'sm' | 'md';
		'aria-label'?: string;
		class?: string;
		id?: string;
		/** Live changes (scrub, arrow keys) — drive latest-wins regeneration from here. */
		oninput?: (value: number) => void;
		/** Gesture end / Enter / blur — commit the override here. */
		oncommit?: (value: number, expression: string | undefined) => void;
		onreset?: () => void;
	};

	let {
		value = $bindable(),
		expression = $bindable(),
		label,
		rowLabel,
		rowName,
		icon: Icon,
		unit,
		min = -Infinity,
		max = Infinity,
		step = 1,
		coarse = 10,
		fine = 0.1,
		precision,
		pixelsPerStep = 2,
		evaluate = createEvaluator(),
		defaultValue,
		overridden: overriddenProp,
		source,
		error: externalError,
		disabled = false,
		size = 'md',
		'aria-label': ariaLabel,
		class: className,
		id,
		oninput,
		oncommit,
		onreset
	}: Props = $props();

	const uid = $props.id();
	const inputId = $derived(id ?? `nf-${uid}`);
	const errorId = `nf-err-${uid}`;

	const places = $derived(precision ?? Math.max(decimalsOf(step) + 1, 2));
	const fmt = (n: number) => formatNumber(n, places);

	const overridden = $derived(
		overriddenProp ??
			(defaultValue !== undefined && (expression !== undefined || roundTo(value, places) !== roundTo(defaultValue, places)))
	);

	let inputEl: HTMLInputElement | null = $state(null);
	let focused = $state(false);
	let draft = $state('');
	let scrubbing = $state(false);

	/** Text shown at rest: the expression as typed, else the formatted value. */
	const restText = $derived(expression ?? fmt(value));

	/** Live evaluation of the draft while editing. */
	const preview = $derived(focused ? evaluate(draft) : null);
	const boundsError = (n: number) =>
		n < min ? `Min ${fmt(min)}${unit ? ` ${unit}` : ''}` : n > max ? `Max ${fmt(max)}${unit ? ` ${unit}` : ''}` : null;
	const draftError = $derived.by(() => {
		if (!preview || draft === restText) return null;
		if (!preview.ok) return preview.error;
		return boundsError(preview.value);
	});
	const shownError = $derived(draftError ?? externalError ?? null);

	/** Right-hand quiet text: evaluated value for expressions, else the unit. */
	const trailing = $derived.by(() => {
		if (focused) {
			if (preview?.ok && preview.expression) return `${fmt(preview.value)}${unit ? ` ${unit}` : ''}`;
			return unit ?? '';
		}
		if (expression !== undefined) return `${fmt(value)}${unit ? ` ${unit}` : ''}`;
		return unit ?? '';
	});

	function setValue(n: number, expr: string | undefined) {
		value = roundTo(clamp(n, min, max), Math.max(places, 6));
		expression = expr;
	}

	function multiplier(e: { shiftKey: boolean; altKey: boolean }) {
		return e.shiftKey ? coarse : e.altKey ? fine : 1;
	}

	/* ---------------------------------------------------------------- typing */

	function onfocus() {
		focused = true;
		draft = restText;
		queueMicrotask(() => inputEl?.select());
	}

	function commitDraft(): boolean {
		if (draft === restText) return true;
		const r = evaluate(draft);
		if (!r.ok || boundsError(r.value)) return false;
		setValue(r.value, r.expression);
		draft = restText;
		oncommit?.(value, expression);
		return true;
	}

	function onblur() {
		// Figma behaviour: blur commits; an invalid entry is discarded rather than kept.
		commitDraft();
		focused = false;
	}

	function stepBy(dir: 1 | -1, e: KeyboardEvent) {
		const base = preview?.ok ? preview.value : value;
		const inc = step * multiplier(e);
		// Snap to the step grid when stepping from an off-grid value (Figma does this too).
		const next = roundTo(base + dir * inc, Math.max(places, decimalsOf(inc)));
		setValue(next, undefined);
		draft = restText;
		oninput?.(value);
		oncommit?.(value, undefined);
		queueMicrotask(() => inputEl?.select());
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
			e.preventDefault();
			stepBy(e.key === 'ArrowUp' ? 1 : -1, e);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			if (commitDraft()) inputEl?.select();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			draft = restText;
			inputEl?.blur();
		} else if (e.key === 'Backspace' && (e.metaKey || e.ctrlKey) && overridden) {
			e.preventDefault();
			reset();
		}
	}

	function reset() {
		if (defaultValue !== undefined) {
			value = defaultValue;
			expression = undefined;
		}
		draft = restText;
		onreset?.();
		oncommit?.(value, expression);
	}

	/* ---------------------------------------------------------------- scrubbing */

	let endScrub: (() => void) | undefined;
	onDestroy(() => endScrub?.());

	function onScrubDown(e: PointerEvent) {
		if (disabled || e.button !== 0 || scrubbing) return;
		e.preventDefault();
		let acc = 0;
		scrubbing = true;
		endScrub = startScrub(e, {
			onstart: () => { if (focused) commitDraft(); },
			onmove: (dx, event) => {
				acc += dx / pixelsPerStep;
				const whole = Math.trunc(acc);
				if (!whole) return;
				acc -= whole;
				setValue(value + whole * step * multiplier(event), undefined);
				if (focused) draft = restText;
				oninput?.(value);
			},
			onend: (moved, click) => {
				scrubbing = false;
				endScrub = undefined;
				if (moved) oncommit?.(value, expression);
				else if (click) inputEl?.focus();
			}
		});
	}

	function onHandleDoubleClick(e: MouseEvent) {
		if (disabled || defaultValue === undefined) return;
		e.preventDefault();
		reset();
	}

</script>

<div class={cn('flex min-w-0 flex-col gap-1', className)}>
	<div class={rowLabel ? 'grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] items-center gap-2' : 'contents'}>
	{#if rowLabel}
		<span
			class={cn('relative flex h-7 min-w-0 touch-none items-center text-ui transition-colors duration-[var(--duration-fast)] select-none', overridden ? 'text-fg' : 'text-fg-secondary', scrubbing && 'text-fg')}
			title={`${rowLabel}${rowName && rowName !== rowLabel ? ` (${rowName})` : ''}${defaultValue !== undefined ? ` · default ${fmt(defaultValue)}${unit ? ` ${unit}` : ''}` : ''}${source ? ` · ${source}` : ''}`}
			onpointerdown={onScrubDown}
			style:cursor={scrubCursor}
			data-testid="param-label"
		>
			<span aria-hidden="true" class="override-dot" data-on={overridden ? '' : undefined}></span>
			<span class="truncate">{rowLabel}</span>
		</span>
	{/if}
	<div
		class={cn('field group/nf', size === 'sm' && 'h-6', !(label || Icon) && 'pl-2', scrubbing && '[--field-ring:var(--border-focus)]')}
		data-invalid={shownError ? '' : undefined}
		data-disabled={disabled ? '' : undefined}
		data-overridden={overridden ? '' : undefined}
	>
		{#if label || Icon}
			<!-- Scrub handle. Pointer-only affordance; keyboard users use ↑/↓ in the input. -->
			<span
				aria-hidden="true"
				class={cn(
					'flex h-full w-7 shrink-0 touch-none items-center justify-center text-ui text-fg-tertiary select-none',
					'transition-colors-fast group-hover/nf:text-fg-secondary',
					scrubbing && 'text-fg'
				)}
				onpointerdown={onScrubDown}
				style:cursor={scrubCursor}
				ondblclick={onHandleDoubleClick}
				title={defaultValue !== undefined ? `Drag to adjust · Double-click to reset to ${fmt(defaultValue)}${unit ? ` ${unit}` : ''}` : 'Drag to adjust'}
			>
				{#if Icon}<Icon />{:else}{label}{/if}
			</span>
		{/if}
		<input
			bind:this={inputEl}
			id={inputId}
			type="text"
			inputmode="decimal"
			autocomplete="off"
			spellcheck="false"
			role="spinbutton"
			aria-label={ariaLabel ?? rowLabel ?? label}
			aria-valuenow={value}
			aria-valuemin={Number.isFinite(min) ? min : undefined}
			aria-valuemax={Number.isFinite(max) ? max : undefined}
			aria-valuetext={`${fmt(value)}${unit ? ` ${unit}` : ''}`}
			aria-invalid={shownError ? true : undefined}
			aria-describedby={shownError ? errorId : undefined}
			{disabled}
			value={focused ? draft : restText}
			oninput={(e) => (draft = e.currentTarget.value)}
			{onfocus}
			{onblur}
			{onkeydown}
			class={cn(
				'h-full w-full min-w-0 flex-1 bg-transparent text-ui text-ellipsis tabular outline-none transition-colors duration-[var(--duration-fast)]',
				overridden && !focused ? 'text-override' : 'text-fg'
			)}
		/>
		{#if trailing}
			<span
				class={cn(
					'pointer-events-none shrink-0 pr-2 pl-1 text-ui tabular text-fg-tertiary',
					// Overridden: make room for the reset button, which only appears on hover/focus.
					overridden && !disabled && 'transition-[padding] duration-[var(--duration-fast)] ease-out group-hover/nf:pr-8 group-focus-within/nf:pr-8'
				)}>{trailing}</span
			>
		{/if}
		{#if overridden && !disabled}
			<Tooltip
				label={defaultValue !== undefined
					? `Reset to ${fmt(defaultValue)}${unit ? ` ${unit}` : ''}${source ? ` · ${source}` : ''}`
					: 'Reset'}
				shortcut={['mod', 'backspace']}
			>
				{#snippet trigger(props)}
					<button
						{...props}
						type="button"
						aria-label="Reset to default"
						class="absolute top-1/2 right-1 inline-flex size-5 -translate-y-1/2 opacity-0 group-hover/nf:opacity-100 group-focus-within/nf:opacity-100 focus-visible:opacity-100 items-center justify-center rounded-sm text-fg-tertiary transition-colors-fast hover:bg-hover hover:text-fg focus-ring"
						onclick={reset}
					>
						<RotateCcw size={12} strokeWidth={1.75} />
					</button>
				{/snippet}
			</Tooltip>
		{/if}
		{#if !trailing}
			<span
				class={cn(
					'w-2 shrink-0',
					overridden && !disabled && 'transition-[width] duration-[var(--duration-fast)] group-hover/nf:w-7 group-focus-within/nf:w-7'
				)}
			></span>
		{/if}
	</div>
	</div>
	{#if shownError}
		<p id={errorId} class="px-0.5 text-label text-error" role="alert">{shownError}</p>
	{/if}
</div>
