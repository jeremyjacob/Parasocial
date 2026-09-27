// Passkey flows against /api/auth (packages/sync/src/server/auth.ts).
import { startRegistration, startAuthentication, browserSupportsWebAuthnAutofill } from "@simplewebauthn/browser";

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/auth/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message ?? `Request failed (${res.status})`);
  return data as T;
}

export async function signUp(name: string, invite?: string) {
  const options = await post<any>("register/options", { name, invite });
  const response = await startRegistration({ optionsJSON: options });
  return post<{ user: { userID: string } }>("register/verify", { response });
}

export async function signIn(opts: { autofill?: boolean } = {}) {
  const options = await post<any>("login/options");
  const response = await startAuthentication({ optionsJSON: options, useBrowserAutofill: !!opts.autofill });
  return post<{ user: { userID: string } }>("login/verify", { response });
}

export async function signOut() {
  await post("logout");
}

export async function addPasskey() {
  const options = await post<any>("passkeys/options");
  const response = await startRegistration({ optionsJSON: options });
  return post("passkeys/verify", { response });
}

export { browserSupportsWebAuthnAutofill };

/** WebAuthn errors that just mean "the person dismissed the prompt". */
export function isCancel(e: unknown) {
  const n = (e as { name?: string })?.name;
  return n === "NotAllowedError" || n === "AbortError";
}
