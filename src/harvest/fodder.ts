import { probeSite } from '../recon/probe.ts';
import type { ProbeReport } from '../recon/probe.ts';
import { HUNT_PROMPT_STRUCTURED, HUNT_PROMPT_VARIANTS } from './prompt.ts';
import { readJson, writeJson } from '../core/store.ts';
import { postJson } from '../core/http.ts';
import { hostOf, truncate, uniq } from '../core/util.ts';

export interface Candidate {
  domain: string;
  url: string;
  credits?: string;
  models?: string[];
  why?: string;
  confidence?: number;
  source: string;
  probed?: {
    score: number;
    verdict: string;
    auth: string;
    autoconfirm?: boolean;
    chat_endpoint?: string;
    models_found: string[];
    gating: string[];
    free_credit_hints: string[];
  };
}

export interface HarvestOptions {
  base?: string;
  key?: string;
  model?: string;
  limit?: number;
  probeLimit?: number;
  seedFile?: string;
}

const DEFAULT_SEEDS: Candidate[] = [
  { domain: 'aethyro.com', url: 'https://aethyro.com/', credits: '200 credits + anonymous trial', models: ['claude-opus-5'], why: 'verified: anonymous trial-chat works, signup bonus', confidence: 0.95, source: 'verified' },
  { domain: 'palvoro.com', url: 'https://www.palvoro.com/', credits: '15000 credits', models: ['claude-opus-4-5', 'gpt-6-astra', 'gemini-3.1-pro-preview', 'deepseek-v4-pro'], why: 'verified: /api/settings/credits exposes signup_bonus_credits', confidence: 0.9, source: 'verified' },
  { domain: 'uhelp.ai', url: 'https://www.uhelp.ai/', credits: '1000 credits', models: ['multi-model'], why: 'verified: better-auth signup page says 1,000 free credits', confidence: 0.85, source: 'verified' },
  { domain: 'superapp.chat', url: 'https://superapp.chat/', credits: '5000 quota', models: ['multi-model'], why: 'auth0 gated, /api/v1/models returns 401', confidence: 0.6, source: 'verified' }
];

function parseCandidates(raw: string, source: string): Candidate[] {
  const out: Candidate[] = [];
  const jsonBlock = raw.match(/\[[\s\S]*\]/);
  if (jsonBlock) {
    try {
      const parsed = JSON.parse(jsonBlock[0]);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (!item || typeof item !== 'object') continue;
          const domain = String((item as any).domain ?? (item as any).url ?? '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
          if (!domain.includes('.')) continue;
          out.push({
            domain,
            url: String((item as any).url ?? 'https://' + domain),
            credits: (item as any).credits ? String((item as any).credits) : undefined,
            models: Array.isArray((item as any).models) ? (item as any).models.map(String) : undefined,
            why: (item as any).why ? String((item as any).why) : undefined,
            confidence: typeof (item as any).confidence === 'number' ? (item as any).confidence : undefined,
            source
          });
        }
      }
    } catch {}
  }
  if (out.length === 0) {
    for (const m of raw.matchAll(/([a-z0-9][a-z0-9\-]{1,40}\.(?:com|ai|chat|io|app|dev|net|co))/gi)) {
      out.push({ domain: m[1].toLowerCase(), url: 'https://' + m[1].toLowerCase(), source });
    }
  }
  return out;
}

export async function askModel(prompt: string, opts: HarvestOptions): Promise<string> {
  if (!opts.base) return '';
  const url = opts.base.replace(/\/$/, '') + '/chat/completions';
  const r = await postJson<any>(url, {
    model: opts.model ?? 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.4,
    stream: false
  }, { headers: { authorization: 'Bearer ' + (opts.key ?? ''), 'content-type': 'application/json' }, timeoutMs: 180000 });
  if (r.status >= 300) return '';
  const content = r.data?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

function verdictOf(r: ProbeReport): string {
  if (r.supabase?.autoconfirm) return 'instant-signup';
  if (r.score >= 60) return 'likely-huntable';
  if (r.score >= 30) return 'partial';
  return 'hard';
}

export async function runHarvest(opts: HarvestOptions = {}): Promise<{ candidates: Candidate[]; reports: ProbeReport[] }> {
  const collected: Candidate[] = [];
  if (opts.base) {
    for (const prompt of HUNT_PROMPT_VARIANTS) {
      const raw = await askModel(prompt, opts);
      if (raw) collected.push(...parseCandidates(raw, 'llm'));
    }
    const structured = await askModel(HUNT_PROMPT_STRUCTURED, opts);
    if (structured) collected.push(...parseCandidates(structured, 'llm-json'));
  }
  const seeds = (await readJson<Candidate[]>(opts.seedFile ?? 'data/seeds.json')) ?? DEFAULT_SEEDS;
  collected.push(...seeds);

  const byDomain = new Map<string, Candidate>();
  for (const c of collected) {
    const key = c.domain.replace(/^www\./, '');
    const prev = byDomain.get(key);
    if (!prev) byDomain.set(key, c);
    else if ((c.confidence ?? 0) > (prev.confidence ?? 0)) byDomain.set(key, { ...prev, ...c });
  }

  const all = [...byDomain.values()].slice(0, opts.limit ?? 24);
  const reports: ProbeReport[] = [];
  const probeTargets = all.slice(0, opts.probeLimit ?? 12);
  for (const c of probeTargets) {
    const report = await probeSite('https://' + c.domain);
    reports.push(report);
    c.probed = {
      score: report.score,
      verdict: verdictOf(report),
      auth: report.supabase ? 'supabase' : report.auth0 ? 'auth0' : report.stack.includes('nextjs') ? 'nextjs' : 'unknown',
      autoconfirm: report.supabase?.autoconfirm,
      chat_endpoint: report.endpoints.find((e) => /chat|completion|messages|functions/i.test(e.endpoint))?.endpoint,
      models_found: report.models.slice(0, 8),
      gating: report.gating,
      free_credit_hints: report.free_credit_hints.slice(0, 3).map((h) => truncate(h, 120))
    };
    await writeJson('data/reports/' + c.domain.replace(/[^a-z0-9.\-]/gi, '_') + '.json', report);
  }

  all.sort((a, b) => (b.probed?.score ?? 0) - (a.probed?.score ?? 0) + ((b.confidence ?? 0) - (a.confidence ?? 0)) * 10);
  await writeJson('data/candidates.json', all);
  return { candidates: all, reports };
}

export function renderHarvestMarkdown(candidates: Candidate[]): string {
  const lines: string[] = ['# 打野候选清单', '', '| # | 站点 | redis | 分 | 判定 | 认证 | autoconfirm | 聊天端点 |', '|---|---|---|---|---|---|---|---|'];
  candidates.forEach((c, i) => {
    const p = c.probed;
    lines.push('| ' + (i + 1) + ' | ' + c.domain + ' | ' + (c.credits ?? '-') + ' | ' + (p?.score ?? '-') + ' | ' + (p?.verdict ?? c.source) + ' | ' + (p?.auth ?? '-') + ' | ' + (p?.autoconfirm === undefined ? '-' : String(p.autoconfirm)) + ' | ' + (p?.chat_endpoint ?? '-') + ' |');
  });
  lines.push('');
  for (const c of candidates) {
    if (!c.probed) continue;
    lines.push('## ' + c.domain);
    if (c.why) lines.push('- 理由: ' + c.why);
    if (c.models?.length) lines.push('- 声称模型: ' + c.models.join(', '));
    if (c.probed.models_found.length) lines.push('- 实测模型: ' + c.probed.models_found.join(', '));
    if (c.probed.chat_endpoint) lines.push('- 端点: ' + c.probed.chat_endpoint);
    if (c.probed.gating.length) lines.push('- 风控: ' + c.probed.gating.join(', '));
    for (const h of c.probed.free_credit_hints) lines.push('- 文案: ' + h);
    lines.push('');
  }
  return lines.join('\n');
}

export { DEFAULT_SEEDS, parseCandidates, uniq, hostOf };
