import { createPlatform, type Platform } from "@parasocial/sync/server";

let p: Promise<Platform> | null = null;
/** The platform, created once on first use (reads env, runs migrations). */
export function platform(): Promise<Platform> {
  return (p ??= createPlatform());
}
