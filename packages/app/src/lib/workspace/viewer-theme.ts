// Viewer colors from the design tokens (orange = selection only).
import { LIGHT, DARK, type ViewerTheme } from '@parasocial/viewer';
import { selection, canvas, status } from '$lib/styles/tokens';

export function viewerTheme(dark: boolean): ViewerTheme {
	const t = dark ? 'dark' : 'light';
	const base = dark ? DARK : LIGHT;
	return {
		...base,
		background: canvas[t].background,
		preselect: selection[t].preselect,
		selectedFill: selection[t].selectedFill,
		selectedStroke: selection[t].selectedStroke,
		error: status[t].error,
		grid: dark ? '#1f1f22' : '#e7e7ea',
		gridMajor: dark ? '#29292d' : '#dadade',
		hiddenLineFill: dark ? '#1b1b1e' : '#ffffff'
	};
}
