import { request, getText, getJson } from '../core/http.ts';
import { uniq, nowIso, joinUrl, originOf, matchToSet, sentences, decodeJwt, pool, clamp, truncate } from '../core/util.ts';

export interface EndpointHit { endpoint: string; score: number; source: string; methods: string[] }
export interface SecretHit { kind: string; value: string; source: string }
export interface RouteHit { path: string; status: number; bytes: number }
export interface SupabaseIntel {
  url: string;
  anon_key?: string;
  role?: string;
  autoconfirm?: boolean;
  providers?: string[];
  functions: string[];
  reachable: boolean;
}
export interface Auth0Intel { domain: string; client_id?: string; signup_endpoint?: string; reachable: boolean }
export interface ProbeReport {
  site: string;
  origin: string;
  fetched_at: string;
  status: number;
  server: string | null;
  cloudflare: boolean;
  captcha: string[];
  stack: string[];
  title?: string;
  description?: string;
  routes: RouteHit[];
  assets_scanned: number;
  asset_bytes: number;
  endpoints: EndpointHit[];
  models: string[];
  secrets: SecretHit[];
  supabase?: SupabaseIntel;
  auth0?: Auth0Intel;
  free_credit_hints: string[];
  gating: string[];
  score: number;
  verdict: string;
}

const DEFAULT_ROUTES = ['/signup', '/login', '/pricing', '/chat', '/app', '/dashboard', '/api/auth/session', '/models'];

const SECRET_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: 'supabase_jwt', re: /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g },
  { kind: 'stripe_pk', re: /pk_(?:live|test)_[A-Za-z0-9]{20,}/g },
  { kind: 'stripe_sk', re: /sk_(?:live|test)_[A-Za-z0-9]{20,}/g },
  { kind: 'anthropic_key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'openai_key', re: /[^a-z-]sk-[A-Za-z0-9_-]{32,}/g },
  { kind: 'google_api_key', re: /AIza[0-9A-Za-z_-]{35}/g },
  { kind: 'sentry_dsn', re: /https:\/\/[a-f0-9]{32}@o[0-9]+\.ingest\.(?:us|de)[0-9]?\.sentry\.io\/[0-9]+/g },
  { kind: 'supabase_url', re: /https:\/\/[a-z0-9]{15,}\.supabase\.co/g }
];

const ENDPOINT_RE = /["'\x60]((?:https?:\/\/[a-z0-9.\-]+\.[a-z]{2,})?(?:\/(?:api|v1|v2|graphql|functions\/v1|auth\/v1|rest\/v1|rpc)\/[A-Za-z0-9_\-./{}:$]{1,80}))["'\x60]/gi;
const MODEL_RE = /["'\x60](claude-[a-z0-9.\-]{2,30}|gpt-[0-9a-z.\-]{2,20}|gemini-[0-9a-z.\-]{2,25}|deepseek-[a-z0-9.\-]{2,20}|grok-[0-9a-z.\-]{2,20})["'\x60]/gi;
const CREDIT_RE = /(?:free|bonus|welcome|signup|sign\s*up|trial|credit|token|gift|start)[^.<>{}]{0,80}?(?:[0-9][0-9,.]*\s*(?:credits?|tokens?|usd|points?|积分|额度))/i;
const DASH_RE = /["'\x60](-{2,}[a-z0-9\-]{3,})["'\x60]/g;

function scoreEndpoint(ep: string): number {
  const p = ep.toLowerCase();
  let s = 10;
  if (/\/chat|completions?|messages|generate|inference|converse/.test(p)) s += 60;
  if (/stream/.test(p)) s += 6;
  if (/signup|register|dbconnections/.test(p)) s += 40;
  if (/login|token|session|authorize/.test(p)) s += 20;
  if (/credits?|balance|usage|quota|billing/.test(p)) s += 25;
  if (/models/.test(p)) s += 18;
  if (/example\.com|schema\.org|w3\.org/.test(p)) s = 0;
  return s;
}

function detectStack(html: string, headers: Headers, url: string): string[] {
  const out: string[] = [];
  const server = headers.get('server') ?? '';
  if (/_next\/static/.test(html)) out.push('nextjs');
  if (/_expo\/static|__expo-metro-runtime/.test(html)) out.push('expo-web');
  if (/\/assets\/index-[A-Za-z0-9_-]{6,}\.js|@vite\/client/.test(html)) out.push('vite');
  if (/__NUXT__|\/_nuxt\//.test(html)) out.push('nuxt');
  if (/wp-content|wp-includes/.test(html)) out.push('wordpress');
  if (/supabase/i.test(html)) out.push('supabase');
  if (/clerk/i.test(html)) out.push('clerk');
  if (/firebase/i.test(html)) out.push('firebase');
  if (/cloudflare/i.test(server)) out.push('cloudflare');
  if (/vercel/i.test(server)) out.push('vercel');
  if (/Static HTML export|static hosting/i.test(html)) out.push('static-html');
  return uniq(out);
}

function collectAssets(html: string, base: string): string[] {
  const raw = [
    ...matchToSet(/<script[^>]+src=["']([^"']+)["']/gi, html),
    ...matchToSet(/<link[^>]+href=["']([^"']+\.js)["']/gi, html),
    ...matchToSet(/"(static\/chunks\/[A-Za-z0-9_\-./]+\.js)"/g, html),
    ...matchToSet(/["'](\/_expo\/static\/[^"']+\.js)["']/g, html),
    ...matchToSet(/["'](\/assets\/[A-Za-z0-9_.\-]+\.js)["']/g, html),
    ...matchToSet(/["'](\/[A-Za-z0-9_.\-]+config\.js)["']/g, html),
    ...matchToSet(/["'](\/[a-z0-9_.\-]+\/[A-Za-z0-9_.\-]+\.js)["']/g, html)
  ];
  const abs = raw.map((r) => joinUrl(base, r)).filter((u) => /\.js(?:\?|$)/.test(u));
  return uniq(abs);
}

function collectLinks(html: string): string[] {
  return uniq(matchToSet(/href="(\/?[a-z0-9\-_.\/]{2,40})"/gi, html))
    .filter((href) => !href.startsWith('/_next') && !href.startsWith('/assets') && !href.startsWith('/cdn-cgi') && !/\.[a-z]{2,5}$/i.test(href));
}

function creditHints(text: string): string[] {
  const out: string[] = [];
  for (const s of sentences(text)) {
    if (s.length > 170) continue;
    if (CREDIT_RE.test(s)) out.push(truncate(s, 150));
    if (out.length >= 12) break;
  }
  return uniq(out);
}

function gatingSignals(html: string, headers: Headers): string[] {
  const out: string[] = [];
  const server = headers.get('server') ?? '';
  if (/cloudflare/i.test(server)) out.push('cloudflare-front');
  if (/challenges\.cloudflare\.com|cf-chl|cf-turnstile|turnstile/i.test(html)) out.push('turnstile-or-challenge');
  if (/cf-chl-widget|cf-chl-/i.test(html)) out.push('cf-captcha-widget');
  if (/hcaptcha/i.test(html)) out.push('hcaptcha');
  if (/g-recaptcha|recaptcha\/api/i.test(html)) out.push('recaptcha');
  if (/cdn-cgi\/challenge-platform/i.test(html)) out.push('cf-jsd-challenge');
  return uniq(out);
}

async function scanAsset(url: string): Promise<{ url: string; text: string }> {
  try {
    const r = await request(url, { maxBytes: 2200000, timeoutMs: 25000, retries: 1, headers: { accept: '*/*' } });
    return { url, text: r.ok ? r.text : '' };
  } catch { return { url, text: '' }; }
}

async function supabaseIntel(hosts: string[], blobs: string[]): Promise<SupabaseIntel | undefined> {
  const joined = blobs.join('\n');
  const rawHost = hosts.find((h) => h.includes('.supabase.co')) ?? uniq(matchToSet(/https:\/\/[a-z0-9]{15,}\.supabase\.co/g, joined))[0];
  if (!rawHost) return undefined;
  const base = rawHost.startsWith('http') ? rawHost.replace(/\/$/, '') : 'https://' + rawHost;
  const settings = await getJson<any>(base + '/auth/v1/settings', { timeoutMs: 20000 });
  let anonKey: string | undefined;
  let role: string | undefined;
  for (const tok of matchToSet(/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, joined)) {
    const payload = decodeJwt(tok);
    const r = String(payload?.role ?? '');
    if (r === 'anon' || r === 'service_role') { anonKey = tok; role = r; break; }
  }
  const functions = uniq(matchToSet(/functions\/v1\/([a-z0-9_\-]+)/gi, joined)).slice(0, 20);
  return {
    url: base,
    anon_key: anonKey,
    role,
    autoconfirm: settings ? settings.mailer_autoconfirm === true : undefined,
    providers: settings && Array.isArray(settings.external) ? settings.external : undefined,
    functions,
    reachable: Boolean(settings)
  };
}

async function auth0Intel(hosts: string[], blobs: string[], site: string): Promise<Auth0Intel | undefined> {
  const joined = blobs.join('\n');
  const hostHit = hosts.find((h) => /auth0\.com$/.test(h));
  const domainHit = uniq(matchToSet(/https:\/\/(auth\.[a-z0-9.\-]+\.[a-z]{2,})/gi, joined))[0];
  const clientId = uniq(matchToSet(/AUTH0_CLIENT_ID"?\s*[:=]\s*"?([A-Za-z0-9]{20,40})/g, joined))[0]
    ?? uniq(matchToSet(/client_id["']?\s*[:=]\s*["']([A-Za-z0-9]{20,40})["']/g, joined))[0];
  if (!hostHit && !domainHit && !clientId) return undefined;
  const domain = (hostHit ?? domainHit ?? '').replace(/^https?:\/\//, '')
    || new URL(site).host.replace(/^www\./, 'auth.');
  const disco = await getJson<any>('https://' + domain + '/.well-known/openid-configuration', { timeoutMs: 20000 });
  return {
    domain,
    client_id: clientId,
    signup_endpoint: disco?.token_endpoint ? 'https://' + domain + '/dbconnections/signup' : undefined,
    reachable: Boolean(disco)
  };
}

export async function probeSite(site: string, opts: { routeLimit?: number; assetLimit?: number } = {}): Promise<ProbeReport> {
  const start = site.startsWith('http') ? site : 'https://' + site;
  const origin = originOf(start);
  const report: ProbeReport = {
    site: start, origin, fetched_at: nowIso(), status: 0, server: null, cloudflare: false, captcha: [],
    stack: [], routes: [], assets_scanned: 0, asset_bytes: 0, endpoints: [], models: [], secrets: [],
    free_credit_hints: [], gating: [], score: 0, verdict: 'unreachable'
  };

  let root;
  try {
    root = await request(start, { maxBytes: 3500000, timeoutMs: 30000, retries: 1 });
  } catch (e: any) {
    report.verdict = 'unreachable: ' + String(e?.message ?? 'fetch failed');
    return report;
  }
  report.status = root.status;
  report.server = root.headers.get('server');
  report.cloudflare = Boolean(root.headers.get('cf-ray'));
  const titleMatch = root.text.match(/<title[^>]*>([\s\S]{0,180}?)<\/title>/i);
  report.title = titleMatch ? titleMatch[1].trim() : undefined;
  const descMatch = root.text.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{0,240})["']/i);
  report.description = descMatch ? descMatch[1].replace(/\s+/g, ' ').trim() : undefined;
  report.stack = detectStack(root.text, root.headers, root.url);
  report.gating = gatingSignals(root.text, root.headers);
  report.free_credit_hints = creditHints(root.text);

  const links = collectLinks(root.text);
  const routeList = uniq([...links.filter((l) => l.split('/').length <= 3), ...DEFAULT_ROUTES]).slice(0, opts.routeLimit ?? 10);
  const routeResults = await pool(routeList, 4, async (rel) => {
    const url = joinUrl(origin, rel);
    try {
      const r = await request(url, { maxBytes: 2000000, timeoutMs: 20000 });
      return { path: rel, status: r.status, bytes: r.bytes, html: r.text };
    } catch {
      return { path: rel, status: 0, bytes: 0, html: '' };
    }
  });
  report.routes = routeResults.map((r) => ({ path: r.path, status: r.status, bytes: r.bytes }));

  const htmlBlobs = [root.text, ...routeResults.map((r) => r.html)];
  const assetList = uniq(htmlBlobs.flatMap((h) => collectAssets(h, origin)));
  const configProbes = uniq([
    joinUrl(origin, '/env-config.js'),
    joinUrl(origin, '/pack-config.js'),
    joinUrl(origin, '/config.js'),
    joinUrl(origin, '/api/config')
  ]);
  const scanned = await pool(uniq([...assetList, ...configProbes]).slice(0, opts.assetLimit ?? 24), 5, scanAsset);
  report.assets_scanned = scanned.filter((a) => a.text.length > 0).length;
  report.asset_bytes = scanned.reduce((n, a) => n + a.text.length, 0);

  const blobs = [...htmlBlobs, ...scanned.map((a) => a.text)];
  const joined = blobs.join('\n');
  const hosts = uniq([
    ...matchToSet(/https?:\/\/[a-z0-9.\-]+\.[a-z]{2,}/gi, joined),
    ...matchToSet(/["'\x60]([a-z0-9\-]+\.supabase\.co)["'\x60]/gi, joined).map((h) => 'https://' + h),
    ...matchToSet(/["'\x60]([a-z0-9\-]+\.auth0\.com)["'\x60]/gi, joined).map((h) => 'https://' + h)
  ]).map((h) => h.replace(/\/$/, ''));

  report.supabase = await supabaseIntel(hosts, blobs);
  report.auth0 = await auth0Intel(hosts, blobs, start);

  const endpointMap = new Map<string, EndpointHit>();
  const push = (ep: string, score: number, source: string) => {
    const prev = endpointMap.get(ep);
    if (prev) prev.score = Math.max(prev.score, score);
    else endpointMap.set(ep, { endpoint: ep, score, source, methods: [] });
  };
  for (const ep of matchToSet(ENDPOINT_RE, joined)) {
    const score = scoreEndpoint(ep);
    if (score > 0) push(ep, score, 'bundle');
  }
  for (const host of hosts.filter((h) => /\.(?:ai|com|chat|app)$/.test(h) && /api|chat|v1/.test(h)).slice(0, 12)) {
    push(host, scoreEndpoint(host), 'host');
  }
  if (report.supabase) {
    for (const fn of report.supabase.functions) push(report.supabase.url + '/functions/v1/' + fn, 92, 'supabase-fn');
    push(report.supabase.url + '/auth/v1/signup', 55, 'supabase-auth');
    push(report.supabase.url + '/auth/v1/token?grant_type=password', 45, 'supabase-auth');
  }
  if (report.auth0) push(report.auth0.signup_endpoint ?? 'https://' + report.auth0.domain + '/dbconnections/signup', 60, 'auth0');
  report.endpoints = [...endpointMap.values()].sort((a, b) => b.score - a.score).slice(0, 80);
  report.models = uniq(matchToSet(MODEL_RE, joined)).slice(0, 40);

  const secretHits: SecretHit[] = [];
  for (const { kind, re } of SECRET_PATTERNS) {
    for (const v of matchToSet(re, joined).slice(0, 3)) {
      secretHits.push({ kind, value: v.length > 120 ? truncate(v, 120) : v, source: 'bundle' });
    }
  }
  report.secrets = uniq(secretHits.slice(0, 24));

  let score = 0;
  score += report.status === 200 ? 10 : 0;
  score += report.supabase?.reachable ? 14 : 0;
  score += report.supabase?.autoconfirm ? 16 : 0;
  score += report.supabase?.anon_key ? 12 : 0;
  score += report.auth0?.reachable ? 8 : 0;
  score += report.auth0?.client_id ? 6 : 0;
  score += report.endpoints.some((e) => e.score >= 70) ? 20 : 0;
  score += report.models.length > 0 ? 10 : 0;
  score += report.free_credit_hints.length > 0 ? 8 : 0;
  score -= report.gating.some((g) => /captcha|turnstile|challenge/.test(g)) ? 10 : 0;
  report.score = clamp(Math.round(score), 0, 100);
  report.captcha = report.gating.filter((g) => /captcha|turnstile|challenge/.test(g));
  if (report.supabase?.autoconfirm) report.verdict = 'instant-signup';
  else if (report.score >= 60) report.verdict = 'likely-huntable';
  else if (report.score >= 30) report.verdict = 'partial';
  else report.verdict = 'hard';
  return report;
}

export function summarize(report: ProbeReport): string {
  const lines: string[] = [];
  lines.push(report.site + '  [' + report.status + '] server=' + (report.server ?? '-') + ' cf=' + (report.cloudflare ? 'yes' : 'no') + ' score=' + report.score);
  lines.push('  stack: ' + (report.stack.join(', ') || '-'));
  if (report.title) lines.push('  title: ' + truncate(report.title, 90));
  if (report.supabase) lines.push('  supabase: ' + report.supabase.url + ' anon=' + (report.supabase.anon_key ? 'yes(' + report.supabase.role + ')' : 'no') + ' autoconfirm=' + String(report.supabase.autoconfirm ?? '?') + ' fns=[' + report.supabase.functions.join(',') + ']');
  if (report.auth0) lines.push('  auth0: ' + report.auth0.domain + ' client=' + (report.auth0.client_id ?? '-') + ' reachable=' + report.auth0.reachable);
  if (report.endpoints.length) lines.push('  top: ' + report.endpoints.slice(0, 5).map((e) => e.score + ':' + e.endpoint).join(' | '));
  if (report.models.length) lines.push('  models: ' + report.models.slice(0, 10).join(', '));
  if (report.secrets.length) lines.push('  secrets: ' + uniq(report.secrets.map((s) => s.kind)).join(', '));
  if (report.free_credit_hints.length) lines.push('  credit: ' + truncate(report.free_credit_hints[0], 120));
  if (report.gating.length) lines.push('  gating: ' + report.gating.join(', '));
  lines.push('  verdict: ' + report.verdict);
  return lines.join('\n');
}
