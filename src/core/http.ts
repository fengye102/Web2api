import { sleep } from './util.ts';

const AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
];

let agentCursor = 0;
export const nextAgent = (): string => AGENTS[agentCursor++ % AGENTS.length];

export class CookieJar {
  private hosts = new Map<string, Map<string, string>>();

  private bucket(u: string, create = false): Map<string, string> | undefined {
    let host = '';
    try { host = new URL(u).host; } catch { host = u; }
    let b = this.hosts.get(host);
    if (!b && create) { b = new Map(); this.hosts.set(host, b); }
    return b;
  }

  absorb(u: string, headers: Headers): void {
    const list = typeof (headers as any).getSetCookie === 'function' ? (headers as any).getSetCookie() : [];
    if (!list || list.length === 0) {
      const single = headers.get('set-cookie');
      if (single) list.push(single);
    }
    for (const raw of list as string[]) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const b = this.bucket(u, true)!;
      if (/expires=Thu, 01 Jan 1970|max-age=0/i.test(raw)) b.delete(name);
      else b.set(name, value);
    }
  }

  header(u: string): string {
    const b = this.bucket(u);
    if (!b || b.size === 0) return '';
    return [...b.entries()].map(([k, v]) => k + '=' + v).join('; ');
  }

  raw(u: string): Record<string, string> {
    const b = this.bucket(u);
    return b ? Object.fromEntries(b) : {};
  }

  set(u: string, name: string, value: string): void {
    this.bucket(u, true)!.set(name, value);
  }

  toJSON(): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    for (const [host, b] of this.hosts) out[host] = Object.fromEntries(b);
    return out;
  }

  static fromJSON(obj: Record<string, Record<string, string>>): CookieJar {
    const jar = new CookieJar();
    for (const [host, cookies] of Object.entries(obj ?? {})) {
      const b = new Map<string, string>();
      for (const [k, v] of Object.entries(cookies)) b.set(k, v);
      (jar as any).hosts.set(host, b);
    }
    return jar;
  }
}

export interface ReqOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs?: number;
  maxBytes?: number;
  jar?: CookieJar;
  maxRedirects?: number;
  agent?: string;
  retries?: number;
}

export interface Res {
  ok: boolean;
  status: number;
  url: string;
  headers: Headers;
  text: string;
  bytes: number;
  truncated: boolean;
  ms: number;
}

async function readCapped(r: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!r.body) return { text: '', truncated: false };
  const reader = (r.body as any).getReader();
  const chunks: Buffer[] = [];
  let n = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const buf = Buffer.from(value);
    if (n + buf.length > maxBytes) {
      chunks.push(buf.subarray(0, maxBytes - n));
      n = maxBytes;
      truncated = true;
      break;
    }
    chunks.push(buf);
    n += buf.length;
  }
  try { await reader.cancel(); } catch {}
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

async function drain(r: Response): Promise<void> {
  try { await (r.body as any)?.cancel(); } catch {}
}

export async function request(url: string, opts: ReqOpts = {}): Promise<Res> {
  const attempts = (opts.retries ?? 1) + 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(600 * attempt);
    try {
      return await once(url, opts);
    } catch (e) { lastErr = e; }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function once(url: string, opts: ReqOpts): Promise<Res> {
  const started = Date.now();
  const maxRedirects = opts.maxRedirects ?? 5;
  let current = url;
  let method = (opts.method ?? 'GET').toUpperCase();
  let body = opts.body;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const headers: Record<string, string> = {
      'user-agent': opts.agent ?? nextAgent(),
      'accept-language': 'en-US,en;q=0.9',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...(opts.headers ?? {})
    };
    if (opts.jar) {
      const cookie = opts.jar.header(current);
      if (cookie) headers.cookie = cookie;
    }
    const r = await fetch(current, {
      method,
      headers,
      body: body as any,
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30000)
    });
    if (opts.jar) opts.jar.absorb(current, r.headers);
    const location = r.headers.get('location');
    if ([301, 302, 303, 307, 308].includes(r.status) && location) {
      await drain(r);
      current = new URL(location, current).toString();
      if (r.status === 303) { method = 'GET'; body = undefined; }
      continue;
    }
    const { text, truncated } = await readCapped(r, opts.maxBytes ?? 3_000_000);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      url: current,
      headers: r.headers,
      text,
      bytes: text.length,
      truncated,
      ms: Date.now() - started
    };
  }
  throw new Error('redirect loop: ' + url);
}

export async function getText(url: string, opts: ReqOpts = {}): Promise<string> {
  try {
    const r = await request(url, { ...opts, retries: opts.retries ?? 1 });
    return r.ok ? r.text : '';
  } catch { return ''; }
}

export async function getJson<T = unknown>(url: string, opts: ReqOpts = {}): Promise<T | undefined> {
  const text = await getText(url, { ...opts, headers: { accept: 'application/json', ...(opts.headers ?? {}) } });
  if (!text) return undefined;
  try { return JSON.parse(text) as T; } catch { return undefined; }
}

export async function postJson<T = unknown>(url: string, payload: unknown, opts: ReqOpts = {}): Promise<{ status: number; data?: T; text: string; headers: Headers }> {
  const r = await request(url, {
    ...opts,
    method: 'POST',
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(opts.headers ?? {}) }
  });
  let data: T | undefined;
  try { data = JSON.parse(r.text) as T; } catch { data = undefined; }
  return { status: r.status, data, text: r.text, headers: r.headers };
}

export async function head(url: string, opts: ReqOpts = {}): Promise<{ status: number; headers: Headers } | undefined> {
  try {
    const r = await fetch(url, { method: 'HEAD', headers: { 'user-agent': opts.agent ?? nextAgent(), ...(opts.headers ?? {}) }, redirect: 'follow', signal: AbortSignal.timeout(opts.timeoutMs ?? 20000) });
    return { status: r.status, headers: r.headers };
  } catch { return undefined; }
}
