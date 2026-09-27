import { createZero, type ParasocialZero } from "@parasocial/sync";

let current: { userID: string; zero: ParasocialZero } | null = null;

/** One Zero client per signed-in user, created lazily in the browser. */
export function zeroFor(userID: string): ParasocialZero {
  if (current?.userID === userID) return current.zero;
  current?.zero.close();
  const zero = createZero({ userID, cacheURL: `${location.origin}/zero` });
  current = { userID, zero };
  return zero;
}

export function newID(): string {
  return crypto.randomUUID();
}
