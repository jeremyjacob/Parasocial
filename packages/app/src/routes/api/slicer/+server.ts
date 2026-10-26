import { error, json } from "@sveltejs/kit";
import { platform } from "$lib/server/platform";
import { putSlicerFile } from "$lib/server/slicer";

export const POST = async ({ request, url }) => {
  const token = putSlicerFile(new Uint8Array(await request.arrayBuffer()));
  if (!token) error(413, "File too large");
  const name = (url.searchParams.get("name") || "parts").replace(/[^\w .()-]+/g, "-");
  const origin = (await platform()).config.appOrigin;
  return json({ url: `${origin}/api/slicer/${token}/${encodeURIComponent(name)}.3mf` });
};
