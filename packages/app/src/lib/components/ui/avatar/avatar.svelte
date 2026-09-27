<script lang="ts" module>
	export type AgentStatus = 'idle' | 'working' | 'writing';
	export type Person = {
		name: string;
		kind: 'human' | 'agent';
		src?: string;
		/** Agents only. `working`/`writing` get the animated ring. */
		status?: AgentStatus;
		/** Humans only: currently in the document. */
		online?: boolean;
	};

	import { avatarTints } from '$lib/styles/tokens';

	/** Stable identity tint per name (humans only). */
	export function tintFor(name: string) {
		let h = 0;
		for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
		return avatarTints[h % avatarTints.length];
	}
	export function initials(name: string) {
		const parts = name.trim().split(/\s+/);
		return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : '')).toUpperCase();
	}
</script>

<script lang="ts">
	import { cn } from '$lib/utils';

	type Props = Person & {
		size?: 20 | 24 | 28 | 32;
		/** Ring colour matching the surface, for stacks. */
		ring?: boolean;
		class?: string;
	};
	let { name, kind, src, status = 'idle', online, size = 24, ring = false, class: className }: Props = $props();

	const busy = $derived(kind === 'agent' && status !== 'idle');
	const label = $derived(
		kind === 'agent' ? `${name} (agent${status === 'idle' ? '' : `, ${status}`})` : `${name}${online ? ' (online)' : ''}`
	);
	// Agents are squircles: radius = 25% of size keeps them clearly not-a-person.
	const radius = $derived(kind === 'agent' ? Math.round(size * 0.28) : size / 2);
</script>

<span
	role="img"
	aria-label={label}
	title={label}
	class={cn('relative inline-flex shrink-0', className)}
	style="width:{size}px;height:{size}px"
>
	{#if busy}
		<!-- Working agents: a slow conic sweep in the accent colour around the squircle. -->
		<span
			aria-hidden="true"
			class="absolute -inset-[2px] animate-[ps-spin_2.4s_linear_infinite] motion-reduce:animate-none"
			style="border-radius:{radius + 2}px;background:conic-gradient(from 0deg, transparent 0 55%, var(--accent) 85%, transparent 100%)"
		></span>
	{/if}
	<span
		class={cn(
			'relative inline-flex size-full items-center justify-center overflow-hidden font-semibold select-none',
			kind === 'agent'
				? 'bg-agent bg-[linear-gradient(180deg,rgb(255_255_255/0.18),transparent_65%)] text-white shadow-[inset_0_0_0_0.5px_rgb(255_255_255/0.14)]'
				: 'text-[#2a2a2e]' /* human tints are always pale */,
			(ring || busy) && 'shadow-[0_0_0_1.5px_var(--bg-panel)]'
		)}
		style="border-radius:{radius}px;font-size:{Math.round(size * 0.4)}px;{kind === 'human' && !src
			? `background:${tintFor(name)}`
			: ''}"
	>
		{#if src}
			<img {src} alt="" class="size-full object-cover" />
		{:else if kind === 'agent'}
			<!-- Concave four-point sparkle: reads as "AI" even at 20px (lucide's Sparkle reads as "+"). -->
			<svg viewBox="0 0 24 24" width={Math.round(size * 0.56)} height={Math.round(size * 0.56)} aria-hidden="true">
				<path
					fill="currentColor"
					d="M12 1.5c.5 5.8 4.7 10 10.5 10.5-5.8.5-10 4.7-10.5 10.5-.5-5.8-4.7-10-10.5-10.5C7.3 11.5 11.5 7.3 12 1.5Z"
				/>
			</svg>
		{:else}
			{initials(name)}
		{/if}
	</span>
	{#if kind === 'human' && online}
		<span
			aria-hidden="true"
			class="absolute -right-px -bottom-px size-2 rounded-full bg-ok shadow-[0_0_0_1.5px_var(--bg-panel)]"
		></span>
	{/if}
</span>
