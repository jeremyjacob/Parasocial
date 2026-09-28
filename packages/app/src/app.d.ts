declare global {
	namespace App {
		interface Locals {
			user: { userID: string; name: string; isAdmin: boolean } | null;
			/** Link-preview tags for this page (lib/server/meta.ts); unset: the site card. */
			meta?: import('$lib/server/meta').Meta;
		}
	}
}
export {};
