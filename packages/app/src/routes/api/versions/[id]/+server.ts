import { platform } from "$lib/server/platform";
export const GET = async ({ request }) => (await platform()).versions(request);
