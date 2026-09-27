// Monaco, lazy-loaded when Code mode first opens and prefetched when the browser is idle (§8, §9).
// Typed against the real `parasocial` API (.d.ts generated from packages/api).
import { API_DTS } from '@parasocial/mcp/resources';

type Monaco = typeof import('monaco-editor');
let loading: Promise<Monaco> | null = null;

export function loadMonaco(): Promise<Monaco> {
	return (loading ??= (async () => {
		const [monaco, { default: EditorWorker }, { default: TsWorker }] = await Promise.all([
			import('monaco-editor'),
			import('monaco-editor/editor/editor.worker?worker'),
			import('monaco-editor/language/typescript/ts.worker?worker')
		]);
		(self as any).MonacoEnvironment = {
			getWorker: (_: unknown, label: string) => (label === 'typescript' || label === 'javascript' ? new TsWorker() : new EditorWorker())
		};
		const ts = (monaco as any).typescript ?? (monaco.languages as any).typescript;
		ts.typescriptDefaults.setCompilerOptions({
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.NodeJs,
			allowNonTsExtensions: true,
			strict: false,
			noEmit: true
		});
		// completions and hovers come from the API types; errors come from regeneration (markers), not tsc
		ts.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
		const prelude = 'type Vec3 = [number, number, number]; type OpRecord = unknown; type EntityKind = "face" | "edge" | "vertex"; type BBox = { min: Vec3; max: Vec3 }; type KernelError = Error; type PartContext = unknown;';
		ts.typescriptDefaults.addExtraLib(`declare module "parasocial" {\n${prelude}\n${API_DTS.replace(/^export declare /gm, 'export ').replace(/^declare /gm, '')}\n}`, 'file:///node_modules/parasocial/index.d.ts');
		const base = (dark: boolean) => ({
			base: (dark ? 'vs-dark' : 'vs') as 'vs' | 'vs-dark',
			inherit: true,
			rules: [],
			colors: dark
				? { 'editor.background': '#1b1b1e', 'editorLineNumber.foreground': '#52525b', 'editor.lineHighlightBackground': '#ffffff08', 'editorGutter.background': '#1b1b1e' }
				: { 'editor.background': '#ffffff', 'editorLineNumber.foreground': '#a1a1aa', 'editor.lineHighlightBackground': '#0000000a', 'editorGutter.background': '#ffffff' }
		});
		monaco.editor.defineTheme('ps-light', base(false));
		monaco.editor.defineTheme('ps-dark', base(true));
		return monaco;
	})());
}

/** Warm Monaco in the background once the page is idle. */
export function prefetchMonaco() {
	if (typeof window === 'undefined') return;
	const go = () => loadMonaco().catch(() => {});
	if ('requestIdleCallback' in window) (window as any).requestIdleCallback(go, { timeout: 8000 });
	else setTimeout(go, 3000);
}
