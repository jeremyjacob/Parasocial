import type { LucideIcon } from '@lucide/svelte';

export type MenuEntry =
	| {
			type?: 'item';
			label: string;
			icon?: LucideIcon;
			shortcut?: string[];
			disabled?: boolean;
			destructive?: boolean;
			onSelect?: () => void;
	  }
	| { type: 'checkbox'; label: string; checked: boolean; shortcut?: string[]; onCheckedChange?: (v: boolean) => void; /** stay open after toggling (filters, toggles) */ keepOpen?: boolean }
	| { type: 'separator' }
	| { type: 'label'; label: string }
	| { type: 'sub'; label: string; icon?: LucideIcon; items: MenuEntry[] };
