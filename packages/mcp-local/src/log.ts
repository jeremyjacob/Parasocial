// stdout carries the MCP protocol; everything human-readable goes to stderr.
export const log = (...args: unknown[]) => console.error("[parasocial]", ...args);
