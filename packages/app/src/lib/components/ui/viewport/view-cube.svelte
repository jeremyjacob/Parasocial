<script lang="ts">
	import { cn } from '$lib/utils';
	let { size = 64, class: className }: { size?: number; class?: string } = $props();
</script>

<!--
	Static placeholder for the view cube (the real one lives in the viewer package).
	Faces use surface tokens, lit from the top, so it reads in both themes. Labels are left to
	the real implementation, which can render them in perspective.
-->
<svg viewBox="0 0 64 64" width={size} height={size} class={cn(className)} role="img" aria-label="View cube">
	<g stroke="var(--border-strong)" stroke-width="1" stroke-linejoin="round">
		<path d="M32 9 52 20.5 32 32 12 20.5Z" fill="var(--bg-elevated)" />
		<path d="M12 20.5 32 32v23L12 43.5Z" fill="var(--bg-control-hover)" />
		<path d="M52 20.5 32 32v23l20-11.5Z" fill="var(--bg-input)" />
	</g>
	<g fill="var(--fg-tertiary)" font-family="var(--font-sans)" font-size="7" font-weight="600" text-anchor="middle">
		<text transform="translate(32 20.5) matrix(.866 .5 -.866 .5 0 0)" y="2.5">TOP</text>
		<text transform="translate(22 37.75) matrix(.866 .5 0 1 0 0)" y="2" font-size="5.5">FRONT</text>
		<text transform="translate(42 37.75) matrix(.866 -.5 0 1 0 0)" y="2" font-size="5.5">RIGHT</text>
	</g>
</svg>
