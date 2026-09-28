<script lang="ts" module>
	export type NoteImage = {
		/** Displayable URL; undefined while it's being signed. */
		src?: string;
		uploading?: boolean;
		failed?: boolean;
		/** Show a remove button (composer attachments). */
		onremove?: () => void;
	};
</script>

<script lang="ts">
	import { LoaderCircle, X } from '@lucide/svelte';
	import { cn } from '$lib/utils';
	import { Skeleton } from '$lib/components/ui/feedback';

	/** `compact`: small removable squares for a composer; otherwise thumbnails that open full size. */
	let { images, compact = false, class: className }: { images: NoteImage[]; compact?: boolean; class?: string } = $props();
	// one image reads at its own shape; several line up as squares
	const single = $derived(!compact && images.length === 1);
</script>

<div class={cn('flex flex-wrap gap-1.5', className)} data-testid="note-images">
	{#each images as img, i (i)}
		{@const box = compact ? 'size-12' : single ? 'max-h-48 max-w-full' : 'size-20'}
		<div class={cn('relative overflow-hidden rounded-md bg-active shadow-[inset_0_0_0_1px_var(--border-subtle)]', !single && box, img.failed && 'shadow-[inset_0_0_0_1px_var(--status-error)]')}>
			{#if !img.src}
				<Skeleton class={cn('rounded-md', single ? 'h-32 w-48' : 'size-full')} />
			{:else if compact}
				<img src={img.src} alt="Attachment {i + 1}" class={cn('size-full object-cover', (img.uploading || img.failed) && 'opacity-50')} />
			{:else}
				<a href={img.src} target="_blank" rel="noopener noreferrer" class="focus-ring block rounded-md" title="Open image">
					<img src={img.src} alt="Image {i + 1}" loading="lazy" class={cn('block', single ? 'max-h-48 max-w-full object-contain' : 'size-20 object-cover')} />
				</a>
			{/if}
			{#if img.uploading}
				<span class="absolute inset-0 flex items-center justify-center text-fg"><LoaderCircle size={14} class="animate-spin" /></span>
			{/if}
			{#if img.onremove}
				<button
					type="button"
					class="focus-ring absolute top-0.5 right-0.5 flex size-4 items-center justify-center rounded-full bg-elevated text-fg-secondary shadow-control hover:text-fg"
					aria-label="Remove image"
					title="Remove image"
					onclick={img.onremove}><X size={10} strokeWidth={2.5} /></button
				>
			{/if}
		</div>
	{/each}
</div>
