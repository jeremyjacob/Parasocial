<script lang="ts">
	import { Dialog } from 'bits-ui';
	import type { Snippet } from 'svelte';
	import { X } from '@lucide/svelte';
	import { cn } from '$lib/utils';
	import { usePortalTarget } from '$lib/theme.svelte';

	type Props = {
		open?: boolean;
		title: string;
		description?: string;
		/** Optional trigger; dialogs can also be opened programmatically via `open`. */
		trigger?: Snippet<[Record<string, unknown>]>;
		children?: Snippet;
		/** Right-aligned footer actions. */
		footer?: Snippet;
		class?: string;
	};
	let { open = $bindable(false), title, description, trigger, children, footer, class: className }: Props = $props();
	const portalTarget = usePortalTarget();
	let content = $state<HTMLElement | null>(null);

	// focus (and select) the first text field instead of bits-ui's default first-tabbable (the close button)
	function focusField(e: Event) {
		const field = content?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input:not([type=hidden]):not([disabled]), textarea:not([disabled])');
		if (!field) return;
		e.preventDefault();
		field.focus();
		field.select();
	}
</script>

<Dialog.Root bind:open>
	{#if trigger}
		<Dialog.Trigger>
			{#snippet child({ props })}{@render trigger(props)}{/snippet}
		</Dialog.Trigger>
	{/if}
	<Dialog.Portal to={portalTarget()}>
		<Dialog.Overlay class="animate-fade fixed inset-0 z-50 bg-overlay" />
		<Dialog.Content
			bind:ref={content}
			onOpenAutoFocus={focusField}
			class={cn(
				'fixed top-1/2 left-1/2 z-50 flex w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col',
				'rounded-dialog bg-elevated text-ui text-fg shadow-dialog outline-none',
				'data-[state=open]:animate-[ps-dialog-in_var(--duration-slow)_var(--ease-out)]',
				className
			)}
		>
			<div class="flex items-start gap-3 px-5 pt-4 pb-1">
				<div class="flex min-w-0 flex-1 flex-col gap-1">
					<Dialog.Title class="text-title">{title}</Dialog.Title>
					{#if description}
						<Dialog.Description class="text-ui text-fg-secondary">{description}</Dialog.Description>
					{/if}
				</div>
				<Dialog.Close
					class="-mt-0.5 -mr-2 inline-flex size-7 items-center justify-center rounded-control text-fg-secondary transition-colors-fast hover:bg-hover hover:text-fg focus-ring"
					aria-label="Close"
				>
					<X />
				</Dialog.Close>
			</div>
			{#if children}<div class={cn('px-5 pt-3', footer ? 'pb-3' : 'pb-5')}>{@render children()}</div>{/if}
			{#if footer}
				<div class="flex items-center justify-end gap-2 px-5 pt-1 pb-5">{@render footer()}</div>
			{/if}
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
