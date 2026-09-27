<script lang="ts" module>
	import { tv } from '$lib/tv';
	export const badgeVariants = tv({
		base: 'inline-flex h-5 shrink-0 items-center gap-1 rounded-sm px-1.5 text-label font-medium whitespace-nowrap tabular [&_svg]:size-3',
		variants: {
			tone: {
				neutral: 'bg-active text-fg-secondary',
				accent: 'bg-accent-subtle text-accent-fg',
				ok: 'bg-ok-subtle text-ok',
				warning: 'bg-warning-subtle text-warning',
				error: 'bg-error-subtle text-error',
				agent: 'bg-agent-subtle text-agent',
				outline: 'text-fg-secondary shadow-[inset_0_0_0_1px_var(--border-default)]'
			}
		},
		defaultVariants: { tone: 'neutral' }
	});
	export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warning' | 'error' | 'agent' | 'outline';
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';
	let { tone = 'neutral', class: className, children }: { tone?: BadgeTone; class?: string; children: Snippet } =
		$props();
</script>

<span class={cn(badgeVariants({ tone }), className)}>{@render children()}</span>
