// Authorization endpoint: validates the request, then hands off to the consent page (which
// requires a passkey sign-in). Redirect-URI problems never redirect.
import { redirect } from "@sveltejs/kit";
export const GET = ({ url }) => redirect(303, `/oauth/consent?${url.searchParams.toString()}`);
