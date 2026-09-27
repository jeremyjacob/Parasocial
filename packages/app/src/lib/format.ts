/** "just now", "5 min ago", "3 h ago", "Sep 12" */
export function relativeTime(ms: number, now = Date.now()): string {
  const d = now - ms;
  if (d < 45_000) return "just now";
  if (d < 3_600_000) return `${Math.round(d / 60_000)} min ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)} h ago`;
  if (d < 7 * 86_400_000) return `${Math.round(d / 86_400_000)} d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Tabular-friendly number formatting: up to `digits` decimals, trailing zeros trimmed. */
export function num(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return "—";
  const s = Number(v.toFixed(digits)).toLocaleString(undefined, { maximumFractionDigits: digits });
  return s === "-0" ? "0" : s;
}
