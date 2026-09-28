// Images pasted, dropped or picked into a note or reply: normalized (models take png/jpeg/webp/gif
// up to a couple thousand pixels), uploaded right away (upload first, then reference: §3), and
// posted as blob hashes with the message.
import { MAX_NOTE_IMAGES } from '@parasocial/sync';
import { toast } from '$lib/components/ui/toast';

export type Attachment = { id: string; url: string; hash?: string; failed?: boolean; upload: Promise<string | null> };

const PASSTHROUGH = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_SIDE = 2048;
const MAX_BYTES = 4 * 1024 * 1024;

/** Files as they go up: models' formats and sizes as-is, anything else re-encoded as webp. */
async function normalize(file: Blob): Promise<Blob> {
	const bmp = await createImageBitmap(file);
	try {
		const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
		if (scale === 1 && PASSTHROUGH.has(file.type) && file.size <= MAX_BYTES) return file;
		const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
		canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
		return await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 });
	} finally {
		bmp.close();
	}
}

/** Image files in a paste or drop (screenshots, copied images, files from Finder). */
export function imageFiles(data: DataTransfer | null): File[] {
	return [...(data?.files ?? [])].filter((f) => f.type.startsWith('image/'));
}

export class Attachments {
	items = $state.raw<Attachment[]>([]);

	/** `local(hash, url)` lets the thread show a just-posted image without signing a URL first. */
	constructor(
		private documentID: () => string,
		private local: (hash: string, url: string) => void
	) {}

	get uploading() {
		return this.items.some((a) => !a.hash && !a.failed);
	}

	add(files: Iterable<Blob>) {
		for (const file of files) {
			if (this.items.length >= MAX_NOTE_IMAGES) {
				toast(`Up to ${MAX_NOTE_IMAGES} images per message`);
				break;
			}
			const id = crypto.randomUUID();
			const url = URL.createObjectURL(file);
			const upload = this.upload(file).then(
				(hash) => {
					this.local(hash, url);
					this.patch(id, { hash });
					return hash;
				},
				(e: Error) => {
					toast.error(e.message);
					this.patch(id, { failed: true });
					return null;
				}
			);
			this.items = [...this.items, { id, url, upload }];
		}
	}

	/** Paste handler: takes the images, leaves text pastes alone. */
	paste = (e: ClipboardEvent) => {
		const files = imageFiles(e.clipboardData);
		if (!files.length) return;
		e.preventDefault();
		this.add(files);
	};

	remove(id: string) {
		const a = this.items.find((x) => x.id === id);
		if (a && !a.hash) URL.revokeObjectURL(a.url);
		this.items = this.items.filter((x) => x.id !== id);
	}

	/** Hashes of every image, once uploaded. Throws if one failed (the message waits for a fix). */
	async hashes(): Promise<string[]> {
		const out = await Promise.all(this.items.map((a) => a.upload));
		if (out.some((h) => !h)) throw new Error("An image didn't upload. Remove it and try again.");
		return out as string[];
	}

	/** After posting: the object URLs of uploaded images stay alive for the thread (see `local`). */
	clear() {
		for (const a of this.items) if (!a.hash) URL.revokeObjectURL(a.url);
		this.items = [];
	}

	private patch(id: string, p: Partial<Attachment>) {
		this.items = this.items.map((a) => (a.id === id ? { ...a, ...p } : a));
	}

	private async upload(file: Blob) {
		const body = await normalize(file);
		const res = await fetch(`/api/blobs?document=${encodeURIComponent(this.documentID())}`, { method: 'POST', body, headers: { 'Content-Type': body.type } });
		if (!res.ok) throw new Error(res.status === 413 ? 'Image too large' : "Couldn't upload the image");
		return ((await res.json()) as { hash: string }).hash;
	}
}
