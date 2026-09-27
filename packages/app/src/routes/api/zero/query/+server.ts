import { platform } from "$lib/server/platform";
export const POST = async ({ request }) => (await platform()).query(request);
