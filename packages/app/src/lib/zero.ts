import { createZero, type ParasocialZero } from "@parasocial/sync";

let current: { userID: string | null; zero: ParasocialZero } | null = null;

/** One Zero client per signed-in user (or one signed-out client, for share links), created lazily in the browser. */
export function zeroFor(userID: string | null): ParasocialZero {
  if (current && current.userID === userID) return current.zero;
  current?.zero.close();
  const zero = createZero({ userID, cacheURL: `${location.origin}/zero` });
  current = { userID, zero };
  return zero;
}

export function newID(): string {
  return crypto.randomUUID();
}
