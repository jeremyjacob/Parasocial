// View-only share links (/s/:token): the document a token opens, and its link-preview card.
import sharp from "sharp";
import { SHARE_TOKEN_RE } from "@parasocial/sync";
import type { Meta } from "./meta";
import { platform } from "./platform";

export type SharedDocument = { id: string; name: string; thumb: string | null };

/** The document this link opens, or null (malformed token, or link sharing off / reset). */
export async function sharedDocument(token: string): Promise<SharedDocument | null> {
  if (!SHARE_TOKEN_RE.test(token)) return null;
  const p = await platform();
  const [d] = await p.db.sql`SELECT id, name, thumb_light FROM documents WHERE share_token = ${token}`;
  return d ? { id: d.id as string, name: d.name as string, thumb: (d.thumb_light as string | null) ?? null } : null;
}

export async function isMember(userID: string, documentID: string) {
  const p = await platform();
  const [m] = await p.db.sql`SELECT 1 FROM document_members WHERE document_id = ${documentID} AND user_id = ${userID}`;
  return !!m;
}

export const CARD_SIZE: [number, number] = [1200, 630];

/** Link-preview tags for /s/:token (undefined: the site card). */
export async function shareMeta(token: string): Promise<Meta | undefined> {
  const d = await sharedDocument(token);
  if (!d) return undefined;
  return {
    title: d.name,
    description: "A parametric model on Parasocial. Open it to look around, read its code and try its params.",
    // the thumbnail hash busts link-preview caches when the model changes
    image: d.thumb ? `/s/${token}/og.jpg?v=${d.thumb.slice(0, 12)}` : "/og.png",
    imageAlt: d.thumb ? `${d.name}, rendered` : "Parasocial: parametric parts rendered in clay",
    imageSize: CARD_SIZE,
  };
}

// The mark (components/app/logo.svelte), flat, for the card's corner.
const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="8 8 108 108" width="40" height="40"><path fill-rule="evenodd" fill="#18181b" fill-opacity="0.72" d="M55.3839 9.82878C59.4778 7.46516 64.5223 7.46613 68.6163 9.82976L103.873 30.1852C107.967 32.5489 110.489 36.917 110.489 41.6442V82.3551C110.489 87.0823 107.967 91.4505 103.873 93.8141L68.6163 114.171C64.5223 116.534 59.4778 116.534 55.3839 114.171L20.127 93.8141C16.0332 91.4505 13.5108 87.0824 13.5108 82.3551V41.6442C13.5108 36.917 16.0331 32.5489 20.127 30.1852L55.3839 9.82878ZM65.6143 36.1276C63.3776 34.8363 60.6216 34.8362 58.3848 36.1276L41.4014 45.9333C39.1646 47.2247 37.7862 49.6112 37.7862 52.194V71.8053C37.7862 74.3882 39.1646 76.7747 41.4014 78.0661L58.3848 87.8718C60.6216 89.1631 63.3775 89.1631 65.6143 87.8718L82.5987 78.0661C84.8354 76.7747 86.213 74.3881 86.213 71.8053V52.194C86.2129 49.6112 84.8355 47.2247 82.5987 45.9333L65.6143 36.1276Z"/></svg>`;

// rendered cards by thumbnail hash (content-addressed, so never stale)
const cards = new Map<string, Uint8Array<ArrayBuffer>>();

/**
 * The link-preview card for a shared document: its light documents-list render (the iso view,
 * 640×360), scaled to fill 1200×630 (the render frames the model loosely, so the crop only takes
 * background), with the mark in the corner. Text-free on purpose: the preview shows the name.
 */
export async function documentCard(thumb: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const hit = cards.get(thumb);
  if (hit) return hit;
  const p = await platform();
  const body = await p.store.get(thumb);
  if (!body) return null;
  const bytes = new Uint8Array(await new Response(body).arrayBuffer());
  const [w, h] = CARD_SIZE;
  const card = new Uint8Array(
    await sharp(bytes)
      .resize(w, h, { fit: "cover", kernel: "lanczos3" })
      .composite([{ input: Buffer.from(MARK), left: w - 40 - 32, top: h - 40 - 28 }])
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer(),
  );
  if (cards.size >= 64) cards.delete(cards.keys().next().value!);
  cards.set(thumb, card);
  return card;
}
