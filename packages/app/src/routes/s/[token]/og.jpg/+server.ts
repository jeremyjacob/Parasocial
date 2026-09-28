import { error } from "@sveltejs/kit";
import { documentCard, sharedDocument } from "$lib/server/share";

/** The link-preview image for a shared document (see documentCard). */
export const GET = async ({ params }) => {
  const d = await sharedDocument(params.token);
  if (!d?.thumb) error(404, "Not found");
  const card = await documentCard(d.thumb);
  if (!card) error(404, "Not found");
  return new Response(card, {
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "public, max-age=3600",
      etag: `"${d.thumb}"`,
      // link unfurlers fetch it from anywhere
      "cross-origin-resource-policy": "cross-origin",
    },
  });
};
