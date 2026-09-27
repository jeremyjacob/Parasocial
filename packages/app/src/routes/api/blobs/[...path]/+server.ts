import { platform } from "$lib/server/platform";
export const GET = async ({ request }) => (await platform()).blobs(request);
export const POST = GET;
