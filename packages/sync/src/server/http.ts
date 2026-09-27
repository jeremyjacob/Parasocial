/** Small Fetch-API helpers shared by the server handlers. */
import type { ServerConfig } from "./config.ts";

export const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...(init.headers ?? {}) },
  });

export const error = (status: number, message: string, extra: Record<string, unknown> = {}) =>
  json({ error: message, ...extra }, { status });

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Wraps a handler so thrown HttpErrors become JSON responses. */
export function handle(fn: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      return await fn(req);
    } catch (e) {
      if (e instanceof HttpError) return error(e.status, e.message, e.extra);
      console.error(e);
      return error(500, "Internal error");
    }
  };
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Origin policy (PLAN §5 Sandboxing):
 *  - A request whose Origin is an engine origin is always rejected. The engine
 *    iframe is same-site with the app, so it could otherwise ride the session
 *    cookie.
 *  - State-changing requests from a browser must come from the app origin
 *    (CSRF). Requests with no Origin (server-to-server, e.g. zero-cache when
 *    the client had none) are allowed through to auth.
 * Returns a 403 Response, or null when the request may proceed.
 */
export function checkOrigin(req: Request, config: Pick<ServerConfig, "appOrigin" | "engineOrigins">): Response | null {
  const origin = req.headers.get("origin");
  if (!origin) return null;
  if (config.engineOrigins.includes(origin)) return error(403, "Requests from the engine origin are not allowed");
  if (UNSAFE.has(req.method) && origin !== config.appOrigin) return error(403, "Cross-origin request rejected");
  return null;
}

export function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = req.headers.get("cookie");
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(
  name: string,
  value: string,
  opts: { maxAgeSec?: number; secure: boolean; path?: string; httpOnly?: boolean; sameSite?: "Lax" | "Strict" },
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? "/"}`, `SameSite=${opts.sameSite ?? "Lax"}`];
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  if (opts.maxAgeSec !== undefined) parts.push(`Max-Age=${opts.maxAgeSec}`);
  return parts.join("; ");
}

export async function readJSON<T = unknown>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}
