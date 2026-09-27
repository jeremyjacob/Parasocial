import { redirect } from "@sveltejs/kit";
// invite links point here (packages/sync auth); sign-up lives on the sign-in page
export const GET = ({ url }) => redirect(303, `/signin?${url.searchParams.toString()}`);
