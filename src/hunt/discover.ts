import { request } from '../core/http.ts';
import { matchToSet, uniq, decodeJwt, joinUrl } from '../core/util.ts';
import { readJson, writeJson } from '../core/store.ts';

export interface SiteConfig {
  host: string;
  origin: string;
  supabase?: { url: string; anon_key: string; autoconfirm?: boolean };
  auth0?: { domain: string; client_id: string; audience?: string };
  endpoints: { id: string; url: string; method: string }[];
  notes: string[];
  discovered_at: string;
}

const JWT_RE = /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g;
const SB_RE = /https:\/\/[a-z0-9]{15,}\.supabase\.co/g;

function anonKeyFrom(blob: string): string | undefined {
  const publishable = matchToSet(/sb_publishable_[A-Za-z0-9_\-]{10,}/g, blob)[0];
  if (publishable) return publishable;
  for (const tok of matchToSet(JWT_RE, blob)) {
    const p = decodeJwt(tok);
    if (String(p?.role ?? '') === 'anon') return tok;
  }
  return undefined;
}

async function grab(url: string, cap = 2_500_000): Promise<string> {
  try {
    const r = await request(url, { maxBytes: cap, timeoutMs: 25000 });
    return r.ok ? r.text : '';
  } catch { return ''; }
}

function scriptsOf(html: string, base: string): string[] {
  return uniq([
    ...matchToSet(/<script[^>]+src=["']([^"']+\.js)["']/gi, html),
    ...matchToSet(/["'](\/_next\/[^"']+\.js)["']/g, html),
    ...matchToSet(/["'](\/assets\/[A-Za-z0-9_.\-]+\.js)["']/g, html)
  ].map((s) => joinUrl(base, s)));
}

export async function discoverSupabase(origin: string, extraPaths: string[] = []): Promise<SiteConfig['supabase'] | undefined> {
  const home = await grab(origin + '/');
  const blobs = [home];
  const paths = uniq(['/app/config.js', '/config.js', '/env-config.js', '/js/config.js', ...extraPaths]);
  for (const p of paths) blobs.push(await grab(joinUrl(origin, p)));
  const scripts = scriptsOf(home, origin).slice(0, 16);
  for (const s of scripts) blobs.push(await grab(s));
  const joined = blobs.join('\n');
  const url = uniq(matchToSet(SB_RE, joined))[0];
  if (!url) return undefined;
  const key = anonKeyFrom(joined);
  if (!key) return { url };
  return { url, anon_key: key };
}

export async function discoverAuth0(origin: string): Promise<SiteConfig['auth0'] | undefined> {
  const env = await grab(origin + '/env-config.js', 400_000);
  const home = await grab(origin + '/');
  const joined = env + '\n' + home;
  const domain = uniq(matchToSet(/AUTH0_DOMAIN"?\s*[:=]\s*"?([a-z0-9.\-]+\.[a-z]{2,})/gi, joined))[0]
    ?? uniq(matchToSet(/https:\/\/(auth\.[a-z0-9.\-]+\.[a-z]{2,})/gi, joined))[0]?.replace(/^https?:\/\//, '');
  const client = uniq(matchToSet(/AUTH0_CLIENT_ID"?\s*[:=]\s*"?([A-Za-z0-9]{20,40})/gi, joined))[0]
    ?? uniq(matchToSet(/client_id["']?\s*[:=]\s*["']([A-Za-z0-9]{20,40})["']/gi, joined))[0];
  const audience = uniq(matchToSet(/AUTH0_AUDIENCE"?\s*[:=]\s*"?(https?:\/\/[^"',\s]+)/gi, joined))[0];
  if (!domain || !client) return undefined;
  return { domain, client_id: client, audience };
}

export async function ensureSiteConfig(hostOrUrl: string, opts: { refresh?: boolean } = {}): Promise<SiteConfig> {
  const origin = hostOrUrl.startsWith('http') ? new URL(hostOrUrl).origin : 'https://' + hostOrUrl;
  const host = new URL(origin).host;
  const rel = 'data/sites/' + host + '.json';
  if (!opts.refresh) {
    const cached = await readJson<SiteConfig>(rel);
    const useful = cached && (cached.supabase || cached.auth0 || cached.endpoints.length > 0);
    if (cached && useful) return cached;
  }
  const notes: string[] = [];
  const supabase = await discoverSupabase(origin);
  if (supabase) notes.push('supabase ' + supabase.url + (supabase.anon_key ? ' (anon key found)' : ' (no anon key)'));
  const auth0 = await discoverAuth0(origin);
  if (auth0) notes.push('auth0 ' + auth0.domain);
  const home = await grab(origin + '/', 1_500_000);
  const blobs = [home];
  for (const s of scriptsOf(home, origin).slice(0, 14)) blobs.push(await grab(s));
  const joined = blobs.join('\n');
  const endpoints = uniq(matchToSet(/["'\x60](\/(?:api|v1)\/[A-Za-z0-9_\-./]{2,60})["'\x60]/g, joined))
    .map((p) => ({ id: p.replace(/\W+/g, '_').replace(/^_+|_+$/g, ''), url: origin + p, method: 'POST' }));
  const cfg: SiteConfig = {
    host, origin, supabase, auth0,
    endpoints: endpoints.slice(0, 40),
    notes,
    discovered_at: new Date().toISOString()
  };
  await writeJson(rel, cfg);
  return cfg;
}
