/**
 * Server configuration, read once from the environment (see deploy/.env.example).
 *
 * DOMAIN is fixed at install: passkeys are bound to the WebAuthn RP ID, so
 * changing it later invalidates every passkey on the instance.
 */
export type ServerConfig = {
  /** WebAuthn relying party ID, e.g. "cad.example.com" (or "localhost" in dev). */
  rpID: string;
  rpName: string;
  /** App origin, e.g. "https://cad.example.com". Used as the WebAuthn expected origin. */
  appOrigin: string;
  /** Engine iframe origin(s). Requests carrying these Origins are rejected outright. */
  engineOrigins: string[];
  /** Postgres connection string (the Zero upstream DB). */
  databaseURL: string;
  /** HMAC key for signed blob URLs and other server-side signatures. >= 32 bytes. */
  secret: string;
  /** Optional shared key zero-cache sends as X-Api-Key to /api/zero/{mutate,query}. */
  zeroApiKey?: string | undefined;
  /** Session lifetime. */
  sessionTTLms: number;
  /** Cookie `Secure` flag. Off only for http://localhost development. */
  secureCookies: boolean;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const domain = must(env, "DOMAIN");
  const appOrigin = env.APP_ORIGIN ?? (domain === "localhost" ? "http://localhost:5173" : `https://${domain}`);
  const engineOrigins = (env.ENGINE_ORIGIN ?? (domain === "localhost" ? "http://localhost:5174" : `https://engine.${domain}`))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const secret = must(env, "APP_SECRET");
  if (secret.length < 32) throw new Error("APP_SECRET must be at least 32 characters");
  return {
    rpID: env.RP_ID ?? domain,
    rpName: env.RP_NAME ?? "Parasocial",
    appOrigin,
    engineOrigins,
    databaseURL: env.DATABASE_URL ?? must(env, "ZERO_UPSTREAM_DB"),
    secret,
    zeroApiKey: env.ZERO_API_KEY || undefined,
    sessionTTLms: Number(env.SESSION_TTL_DAYS ?? 30) * 24 * 60 * 60 * 1000,
    secureCookies: !appOrigin.startsWith("http://"),
  };
}

function must(env: Record<string, string | undefined>, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`${key} is not set`);
  return v;
}
