// The workspace is a client-rendered SPA route (§9): no SSR or hydration.
export const ssr = false;
export const load = ({ params }) => ({ id: params.id });
