const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Parses "90s", "20m", "1h30m" or a bare number of seconds into milliseconds.
 * "none" (no limit) parses to null.
 */
export function parseDuration(input: string): number | null {
  const text = input.trim().toLowerCase();
  if (text === "none") return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)];
  if (parts.length === 0 || parts.map((p) => p[0]).join("") !== text) {
    throw new Error(`invalid duration "${input}" (try 90s, 20m, 2h or none)`);
  }
  return Math.round(parts.reduce((sum, [, n, unit]) => sum + Number(n) * UNITS[unit!]!, 0));
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
}
