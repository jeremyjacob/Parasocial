import { platform } from "$lib/server/platform";
export const GET = async ({ request }) => (await platform()).auth(request);
export const POST = GET;
