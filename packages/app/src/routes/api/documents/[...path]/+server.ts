import { platform } from "$lib/server/platform";
export const GET = async ({ request }) => (await platform()).documents(request);
export const POST = GET;
