import { redirect } from "@sveltejs/kit";
import { platform } from "$lib/server/platform";

export const load = async ({ locals }) => {
  if (!locals.user) redirect(303, "/signin");
  const p = await platform();
  const docs = await p.db.sql`
    SELECT d.id, d.name, d.updated_at, d.head_version, d.thumb_light,
      (SELECT count(*)::int FROM scripts s WHERE s.document_id = d.id AND s.path LIKE 'studios/%') AS studios
    FROM documents d JOIN document_members m ON m.document_id = d.id AND m.user_id = ${locals.user.userID}
    ORDER BY d.updated_at DESC`;
  const thumbs = await p.thumbnailURLs(locals.user.userID, docs.map((d: any) => d.id));
  return {
    docs: docs.map((d: any) => ({ id: d.id as string, name: d.name as string, updatedAt: Number(d.updated_at), headVersion: Number(d.head_version), thumb: (d.thumb_light as string | null) ?? undefined, studios: d.studios as number })),
    thumbs,
  };
};
