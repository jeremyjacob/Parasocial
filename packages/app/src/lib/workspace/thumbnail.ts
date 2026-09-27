// Documents-list thumbnails: the model at the iso view, rendered in each theme by a small offscreen
// viewer (no selection, helpers or markup), so the cards show the document's real geometry.
import { Viewer, VIEW_DIRS, type PartData } from '@parasocial/viewer';
import * as THREE from 'three';
import { viewerTheme } from './viewer-theme';

/** Card-shaped (the documents grid shows them at 1.6–2.2:1 with object-fit: contain). */
const W = 640,
	H = 360;
/** The bounding sphere the viewer fits is loose at the iso view: frame a smaller box so the part fills the card. */
const FILL = 0.85;

export async function renderThumbnails(parts: (Omit<PartData, 'color'> & { color: { light: string; dark: string } })[]): Promise<{ light: Blob; dark: Blob }> {
	const host = document.createElement('div');
	host.style.cssText = `position:fixed;left:-10000px;top:0;width:${W}px;height:${H}px;pointer-events:none;contain:strict`;
	host.setAttribute('aria-hidden', 'true');
	document.body.appendChild(host);
	const v = new Viewer(host, { theme: viewerTheme(false), viewCube: false, maxDpr: 1, reducedMotion: true });
	try {
		v.setHelpers({ grid: false, origin: false });
		for (const p of parts) v.setPart({ ...p, color: p.color.light });
		const box = v.bounds().clone();
		const c = box.getCenter(new THREE.Vector3());
		box.min.sub(c).multiplyScalar(FILL).add(c);
		box.max.sub(c).multiplyScalar(FILL).add(c);
		v.fit(box, false, VIEW_DIRS.iso.clone());
		const light = await v.snapshot('image/webp', 0.9);
		v.setTheme(viewerTheme(true));
		for (const p of parts) v.setPartColor(p.id, p.color.dark);
		const dark = await v.snapshot('image/webp', 0.9);
		return { light, dark };
	} finally {
		v.dispose();
		host.remove();
	}
}
