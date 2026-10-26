import { toast } from '$lib/components/ui/toast';


/** Desktop slicers that open a downloadable file from a `<scheme>://open?file=<url>` link. */
export const SLICERS = [
	{ value: 'orcaslicer', label: 'OrcaSlicer' },
	{ value: 'bambustudio', label: 'Bambu Studio' },
	{ value: 'prusaslicer', label: 'PrusaSlicer', hint: 'allow downloads from any site' },
	{ value: 'cura', label: 'UltiMaker Cura' }
] as const;
export type Slicer = (typeof SLICERS)[number]['value'];

const PREF = 'parasocial:slicer';
export function getSlicer(): Slicer {
	try {
		const v = localStorage.getItem(PREF);
		if (SLICERS.some((s) => s.value === v)) return v as Slicer;
	} catch {}
	return 'orcaslicer';
}
export function setSlicer(s: Slicer) {
	try {
		localStorage.setItem(PREF, s);
	} catch {}
}
export const slicerLabel = (s: Slicer) => SLICERS.find((x) => x.value === s)!.label;

/** Hands a 3MF to the slicer: the server holds it briefly at a URL the slicer downloads from. */
export async function openInSlicer(bytes: Uint8Array, name: string, slicer: Slicer = getSlicer()) {
	const res = await fetch(`/api/slicer?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'content-type': 'model/3mf' }, body: bytes as BodyInit });
	if (!res.ok) throw new Error(`slicer upload failed: ${res.status}`);
	const { url } = (await res.json()) as { url: string };
	const a = document.createElement('a');
	a.href = `${slicer}://open?file=${encodeURIComponent(url)}`;
	a.click();
}

/** The parts as one 3MF, opened in the slicer from Preferences; `name` is the file's. */
export async function sliceParts(engine: { exportParts(parts: string[], format: '3mf'): Promise<Uint8Array> }, parts: string[], name: string) {
	const slicer = getSlicer();
	try {
		const bytes = await engine.exportParts(parts, '3mf');
		await openInSlicer(bytes, name.replace(/[^\w .()-]+/g, '-').replace(/\s+/g, ' ').trim() || 'parts', slicer);
	} catch (e) {
		console.error('open in slicer failed', e);
		toast.error(`Couldn't open in ${slicerLabel(slicer)}. Try again.`);
	}
}
