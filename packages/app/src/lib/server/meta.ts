// Link-preview (Open Graph / Twitter card) tags. Pages that describe something specific set
// `locals.meta` (a share link's are set in hooks.server.ts); every other page gets the site card. hooks.server.ts writes
// the tags into app.html's <!--meta--> slot, so client-rendered routes (ssr = false) unfurl too.

export type Meta = {
	title: string;
	description: string;
	/** Absolute, or a path on the app origin. */
	image: string;
	imageAlt: string;
	/** Width × height of `image`. */
	imageSize?: [number, number];
};

export const SITE_META: Meta = {
	title: 'Parasocial',
	description: 'Parametric CAD in code. Pin notes on the model and your agent makes the change.',
	image: '/og.png',
	imageAlt: 'Parasocial: parametric parts rendered in clay',
	imageSize: [1200, 630]
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderMeta(meta: Meta | undefined, url: URL, origin: string): string {
	const m = meta ?? SITE_META;
	const abs = (u: string) => new URL(u, origin).href;
	const tags: [string, string, string][] = [
		['name', 'description', m.description],
		['property', 'og:site_name', 'Parasocial'],
		['property', 'og:type', 'website'],
		['property', 'og:title', m.title],
		['property', 'og:description', m.description],
		['property', 'og:url', abs(url.pathname)],
		['property', 'og:image', abs(m.image)],
		['property', 'og:image:alt', m.imageAlt],
		...(m.imageSize ? ([['property', 'og:image:width', String(m.imageSize[0])], ['property', 'og:image:height', String(m.imageSize[1])]] as [string, string, string][]) : []),
		['name', 'twitter:card', 'summary_large_image'],
		['name', 'twitter:title', m.title],
		['name', 'twitter:description', m.description],
		['name', 'twitter:image', abs(m.image)]
	];
	return tags.map(([k, v, c]) => `<meta ${k}="${v}" content="${esc(c)}" />`).join('\n\t\t');
}
