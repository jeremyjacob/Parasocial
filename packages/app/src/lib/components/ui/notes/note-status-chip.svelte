<script lang="ts" module>
	export type NoteStatus = 'open' | 'working' | 'review' | 'resolved' | 'orphaned';
</script>

<script lang="ts">
	import { Circle, LoaderCircle, Eye, Check, Unlink } from '@lucide/svelte';
	import { cn } from '$lib/utils';

	let { status, class: className }: { status: NoteStatus; class?: string } = $props();

	const meta = {
		open: { label: 'Open', icon: Circle, cls: 'text-fg-secondary shadow-[inset_0_0_0_1px_var(--border-default)]' },
		working: { label: 'Agent working', icon: LoaderCircle, cls: 'bg-accent-subtle text-accent-fg' },
		review: { label: 'Awaiting review', icon: Eye, cls: 'bg-warning-subtle text-warning' },
		resolved: { label: 'Resolved', icon: Check, cls: 'bg-ok-subtle text-ok' },
		orphaned: { label: 'Detached', icon: Unlink, cls: 'bg-error-subtle text-error' }
	} as const;
	const m = $derived(meta[status]);
</script>

<span
	class={cn(
		'inline-flex h-5 shrink-0 items-center gap-1 rounded-full pr-2 pl-1.5 text-label font-medium whitespace-nowrap',
		m.cls,
		className
	)}
>
	<m.icon
		size={12}
		strokeWidth={2}
		class={cn(status === 'working' && 'animate-[ps-spin_1s_linear_infinite] motion-reduce:animate-none')}
	/>
	{m.label}
</span>
