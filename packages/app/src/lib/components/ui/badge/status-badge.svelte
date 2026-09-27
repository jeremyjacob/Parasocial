<script lang="ts" module>
	export type Status = 'ok' | 'warning' | 'error' | 'pending';
</script>

<script lang="ts">
	import { cn } from '$lib/utils';

	type Props = {
		status: Status;
		/** Omit for a bare dot (lists); include for a pill ("2 errors"). */
		label?: string;
		class?: string;
	};
	let { status, label, class: className }: Props = $props();

	const dot: Record<Status, string> = {
		ok: 'bg-ok',
		warning: 'bg-warning',
		error: 'bg-error',
		pending: 'bg-fg-tertiary animate-pulse'
	};
	const pill: Record<Status, string> = {
		ok: 'bg-ok-subtle text-ok',
		warning: 'bg-warning-subtle text-warning',
		error: 'bg-error-subtle text-error',
		pending: 'bg-active text-fg-secondary'
	};
	const names: Record<Status, string> = { ok: 'OK', warning: 'Warning', error: 'Error', pending: 'Regenerating' };
</script>

{#if label}
	<span
		class={cn(
			'inline-flex h-5 items-center gap-1.5 rounded-sm px-1.5 text-label font-medium whitespace-nowrap tabular',
			pill[status],
			className
		)}
	>
		<span class={cn('size-1.5 rounded-full', dot[status])}></span>{label}
	</span>
{:else}
	<span
		role="img"
		aria-label={names[status]}
		title={names[status]}
		class={cn('inline-block size-1.5 shrink-0 rounded-full', dot[status], className)}
	></span>
{/if}
