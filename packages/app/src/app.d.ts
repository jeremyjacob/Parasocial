declare global {
	namespace App {
		interface Locals {
			user: { userID: string; name: string; isAdmin: boolean } | null;
		}
	}
}
export {};
