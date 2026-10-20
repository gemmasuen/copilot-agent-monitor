export function truncate(text: unknown, max: number): string | undefined {
  if (typeof text !== "string") {
    return undefined;
  }
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return undefined;
  }
  return collapsed.length > max ? collapsed.slice(0, max - 1).trimEnd() + "…" : collapsed;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return "–";
  }
  const s = Math.round(ms / 1000);
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m ${s % 60}s`;
  }
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatTokens(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) {
    return "–";
  }
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1000) {
    return `${Math.round(n / 1000)}k`;
  }
  return String(n);
}

export function formatAgo(ms: number): string {
  if (ms < 5000) {
    return "just now";
  }
  return `${formatDuration(ms)} ago`;
}
