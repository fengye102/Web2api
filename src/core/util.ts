export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const nowIso = () => new Date().toISOString();

export const uniq = <T,>(xs: T[]): T[] => [...new Set(xs)];

export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export const truncate = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n) + '…');

export function safeJson<T = unknown>(s: string): T | undefined {
  try { return JSON.parse(s) as T; } catch { return undefined; }
}

export function originOf(u: string): string {
  try { return new URL(u).origin; } catch { return u; }
}

export function hostOf(u: string): string {
  try { return new URL(u).host; } catch { return u; }
}

export function joinUrl(base: string, rel: string): string {
  try { return new URL(rel, base).toString(); } catch { return rel; }
}

export function matchToSet(re: RegExp, text: string, group = 1): string[] {
  const out: string[] = [];
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
  const g = new RegExp(re.source, flags);
  let groups = 0;
  try { groups = new RegExp(re.source + '|').exec('')!.length - 1; } catch { groups = 0; }
  const idx = Math.min(group, groups);
  for (const m of text.matchAll(g)) {
    const v = m[idx];
    if (v) out.push(v);
  }
  return [...new Set(out)];
}

export function sentences(text: string): string[] {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?。！？])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function decodeJwt(token: string): Record<string, unknown> | undefined {
  const part = token.split('.')[1];
  if (!part) return undefined;
  try {
    const pad = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(pad + '='.repeat((4 - (pad.length % 4)) % 4), 'base64').toString('utf8');
    return safeJson<Record<string, unknown>>(json);
  } catch { return undefined; }
}

export async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function bar(score: number, width = 10): string {
  const filled = Math.round(clamp(score, 0, 100) / 100 * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function fmtTable(rows: string[][]): string {
  if (rows.length === 0) return '';
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows.map((r) => r.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ')).join('\n');
}
