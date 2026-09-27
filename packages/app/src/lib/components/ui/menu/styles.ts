/**
 * Shared floating-surface + menu-item styles for Select, Combobox, DropdownMenu, ContextMenu
 * and Command. Concentric: surface radius 10, padding 4 → item radius 6 (= control radius).
 */
export const floatingSurface =
	'animate-pop z-50 overflow-hidden rounded-[var(--popover-radius)] bg-elevated p-[var(--popover-pad)] text-ui text-fg shadow-popover outline-none';

export const menuContent = `${floatingSurface} min-w-[180px] max-h-[var(--bits-dropdown-menu-content-available-height,320px)] overflow-y-auto`;

export const menuItem = [
	'relative flex h-7 cursor-default items-center gap-2 rounded-[var(--popover-item-radius)] px-2 text-ui text-fg outline-none select-none',
	'data-[highlighted]:bg-accent data-[highlighted]:text-fg-on-accent',
	'data-[disabled]:pointer-events-none data-[disabled]:text-fg-disabled',
	'[&>svg]:shrink-0 [&>svg]:text-fg-secondary data-[highlighted]:[&>svg]:text-fg-on-accent'
].join(' ');

export const menuItemDestructive =
	'text-error [&>svg]:text-error data-[highlighted]:bg-error data-[highlighted]:text-white';

export const menuSeparator = 'mx-2 my-1 h-px bg-line';

export const menuLabel = 'px-2 pt-1.5 pb-1 text-label font-medium text-fg-tertiary';

export const menuShortcut =
	'ml-auto pl-4 text-label tabular text-fg-tertiary group-data-[highlighted]/item:text-fg-on-accent/70';
