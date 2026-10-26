import { error } from "@sveltejs/kit";
import { getSlicerFile } from "$lib/server/slicer";

export const GET = async ({ params }) => {
  const bytes = getSlicerFile(params.token);
  if (!bytes) error(404, "Expired");
  return new Response(bytes as BodyInit, { headers: { "content-type": "model/3mf", "content-disposition": `attachment; filename="${params.name.replace(/"/g, "")}"`, "cache-control": "no-store" } });
};
