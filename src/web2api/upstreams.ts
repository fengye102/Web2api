import { ensureSiteConfig } from '../hunt/discover.ts';
import { supabaseInvoke } from '../hunt/supabase.ts';
import { AccountPool } from '../pool/accounts.ts';
import { estimateUsage, estimateTokens, messageText, lastUserText, splitTrailingJson } from './types.ts';
import type { ChatRequest, StreamPiece, Upstream, UpstreamContext, UpstreamResult, Usage } from './types.ts';
import { ssePieces, textDeltas, tryJson, pickDelta, pickUsage } from './stream.ts';
import { readJson } from '../core/store.ts';
import type { AccountRecord } from '../hunt/sites.ts';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

export const accountsPool = new AccountPool();

async function ensureAccounts(): Promise<void> {
  if (accountsPool.summary().length === 0) await accountsPool.load();
}

function cookieOf(account: AccountRecord): string {
  return Object.entries(account.cookies ?? {}).map(([k, v]) => k + '=' + v).join('; ');
}

export class EchoUpstream implements Upstream {
  id = 'echo';
  label = 'local echo (no network)';
  host = 'localhost';
  models = ['echo-1'];
  supportsStream = true;

  async chat(req: ChatRequest): Promise<UpstreamResult> {
    const prompt = lastUserText(req.messages);
    const text = 'echo: ' + prompt.slice(0, 400);
    return { ok: true, status: 200, text, model: 'echo-1', upstream: this.id, usage: estimateUsage(messageText(req.messages), text) };
  }

  async *chatStream(req: ChatRequest): AsyncIterable<StreamPiece> {
    const prompt = lastUserText(req.messages);
    const text = 'echo: ' + prompt.slice(0, 400);
    for (let i = 0; i < text.length; i += 12) yield { text: text.slice(i, i + 12) };
    yield { usage: estimateUsage(messageText(req.messages), text) };
  }
}

export class UhelpUpstream implements Upstream {
  id = 'uhelp';
  label = 'uhelp.ai (better-auth, 多账号轮换)';
  host = 'www.uhelp.ai';
  models = ['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'gpt-5.5', 'gpt-5.6'];
  supportsStream = true;
  private maxAccounts = 3;

  private payload(req: ChatRequest): string {
    const model = this.models.includes(req.model) ? req.model : 'claude-haiku-4-5-20251001';
    return JSON.stringify({
      model,
      messages: req.messages.map((m) => ({
        role: m.role === 'system' ? 'user' : m.role,
        content: typeof m.content === 'string' ? m.content : m.content.map((c) => c.text ?? '').join('\n')
      }))
    });
  }

  private async post(req: ChatRequest, cookie: string, ctx: UpstreamContext): Promise<Response> {
    return fetch('https://www.uhelp.ai/api/chat', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        origin: 'https://www.uhelp.ai',
        referer: 'https://www.uhelp.ai/chat',
        'user-agent': UA
      },
      body: this.payload(req),
      signal: ctx.signal ?? AbortSignal.timeout(ctx.timeoutMs ?? 120000)
    });
  }

  private async balance(cookie: string): Promise<number | undefined> {
    try {
      const res = await fetch('https://www.uhelp.ai/api/balance', { headers: { cookie, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) return undefined;
      const data = await res.json() as { tokens?: number };
      return typeof data.tokens === 'number' ? data.tokens : undefined;
    } catch { return undefined; }
  }

  async chat(req: ChatRequest, ctx: UpstreamContext): Promise<UpstreamResult> {
    await ensureAccounts();
    const tried = new Set<string>();
    let last: UpstreamResult | undefined;
    for (let i = 0; i < this.maxAccounts; i++) {
      const candidates = accountsPool.pick('uhelp.ai', tried, 1);
      if (candidates.length === 0) break;
      const account = candidates[0];
      tried.add(account.id);
      try {
        const res = await this.post(req, cookieOf(account), ctx);
        const raw = await res.text();
        let text = '';
        let usage: Usage | undefined;
        for (const line of raw.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          const parsed = tryJson(payload);
          if (!parsed) continue;
          text += pickDelta(parsed);
          usage = pickUsage(parsed) ?? usage;
        }
        const remaining = await this.balance(cookieOf(account));
        if (res.ok && text.trim()) {
          accountsPool.report(account.id, { ok: true, status: 200, remaining });
          return {
            ok: true, status: 200, text: text.trim(), model: req.model, upstream: this.id,
            remaining, account_id: account.id,
            usage: usage ?? estimateUsage(messageText(req.messages), text)
          };
        }
        accountsPool.report(account.id, { ok: false, status: res.status || 502, remaining, error: 'chat ' + res.status });
        last = {
          ok: false, status: res.status || 502, text: '', model: req.model, upstream: this.id, raw: raw.slice(0, 300),
          retryable: res.status === 401 || res.status === 402 || res.status === 429 || res.status >= 500,
          detail: 'uhelp account ' + account.email + ' -> ' + (res.status || 'stream error'),
          remaining, account_id: account.id
        };
      } catch (e: any) {
        accountsPool.report(account.id, { ok: false, status: 0, error: String(e?.message ?? e) });
        last = { ok: false, status: 0, text: '', model: req.model, upstream: this.id, retryable: true, detail: String(e?.message ?? e), account_id: account.id };
      }
    }
    return last ?? { ok: false, status: 503, text: '', model: req.model, upstream: this.id, retryable: true, detail: 'no usable uhelp account in pool' };
  }

  async *chatStream(req: ChatRequest, ctx: UpstreamContext): AsyncIterable<StreamPiece> {
    await ensureAccounts();
    const tried = new Set<string>();
    let lastError: any;
    for (let i = 0; i < this.maxAccounts; i++) {
      const candidates = accountsPool.pick('uhelp.ai', tried, 1);
      if (candidates.length === 0) break;
      const account = candidates[0];
      tried.add(account.id);
      let res: Response;
      try {
        res = await this.post(req, cookieOf(account), ctx);
      } catch (e: any) {
        accountsPool.report(account.id, { ok: false, status: 0, error: String(e?.message ?? e) });
        lastError = Object.assign(new Error(String(e?.message ?? e)), { status: 0, retryable: true });
        continue;
      }
      if (!res.ok || !res.body) {
        const raw = await res.text().catch(() => '');
        accountsPool.report(account.id, { ok: false, status: res.status, error: 'chat ' + res.status });
        lastError = Object.assign(new Error('uhelp ' + res.status + ' ' + raw.slice(0, 120)), { status: res.status, retryable: res.status === 401 || res.status === 402 || res.status === 429 || res.status >= 500 });
        if (!lastError.retryable) throw lastError;
        continue;
      }
      let emitted = 0;
      let usage: Usage | undefined;
      for await (const piece of ssePieces(res.body as ReadableStream<Uint8Array>)) {
        if (piece.usage) usage = piece.usage;
        if (piece.text) {
          emitted += piece.text.length;
          yield { text: piece.text, account_id: account.id };
        }
        if (piece.usage && emitted === 0) yield { usage: piece.usage, account_id: account.id };
      }
      const remaining = await this.balance(cookieOf(account));
      if (emitted === 0) {
        accountsPool.report(account.id, { ok: false, status: 502, remaining, error: 'empty stream' });
        lastError = Object.assign(new Error('uhelp empty stream'), { status: 502, retryable: true });
        continue;
      }
      accountsPool.report(account.id, { ok: true, status: 200, remaining });
      yield { usage: usage ?? estimateUsage(messageText(req.messages), ''), account_id: account.id };
      return;
    }
    throw lastError ?? Object.assign(new Error('no usable uhelp account in pool'), { status: 503, retryable: true });
  }
}

export class AethyroTrialUpstream implements Upstream {
  id = 'aethyro-trial';
  label = 'Aethyro anonymous trial-chat (3 msgs/day/IP)';
  host = 'aethyro.com';
  models = ['aethyro-auto', 'claude-opus-5', 'claude-sonnet-5'];
  supportsStream = false;

  async chat(req: ChatRequest, ctx: UpstreamContext): Promise<UpstreamResult> {
    const cfg = await ensureSiteConfig('https://aethyro.com/');
    if (!cfg.supabase?.anon_key) {
      return { ok: false, status: 500, text: '', model: req.model, upstream: this.id, retryable: true, detail: 'supabase config missing' };
    }
    const sbCfg = { url: cfg.supabase.url, anon_key: cfg.supabase.anon_key };
    const prompt = lastUserText(req.messages) || messageText(req.messages);
    const r = await supabaseInvoke(sbCfg, 'trial-chat', { message: prompt }, undefined, { timeoutMs: ctx.timeoutMs ?? 90000 });
    const parsed = splitTrailingJson(r.text);
    const remaining = typeof parsed.meta?.remaining === 'number' ? (parsed.meta.remaining as number) : undefined;
    const error = typeof parsed.meta?.error === 'string' ? (parsed.meta.error as string) : undefined;
    if (r.status !== 200) {
      return { ok: false, status: r.status, text: '', model: req.model, upstream: this.id, raw: r.text, retryable: r.status === 429, detail: error ?? ('trial-chat ' + r.status), remaining };
    }
    const text = parsed.text.replace(/^data:\s*/gm, '').trim();
    return { ok: true, status: 200, text, model: req.model, upstream: this.id, raw: r.text, remaining, usage: estimateUsage(prompt, text) };
  }
}

export class AethyroAccountUpstream implements Upstream {
  id = 'aethyro-account';
  label = 'Aethyro signed-in chat (多账号轮换 /functions/v1/chat)';
  host = 'aethyro.com';
  models = ['aethyro-auto', 'claude-opus-5', 'claude-sonnet-5'];
  supportsStream = false;
  private maxAccounts = 3;

  async chat(req: ChatRequest, ctx: UpstreamContext): Promise<UpstreamResult> {
    const cfg = await ensureSiteConfig('https://aethyro.com/');
    if (!cfg.supabase?.anon_key) {
      return { ok: false, status: 500, text: '', model: req.model, upstream: this.id, retryable: true, detail: 'supabase config missing' };
    }
    const sbCfg = { url: cfg.supabase.url, anon_key: cfg.supabase.anon_key };
    const prompt = lastUserText(req.messages) || messageText(req.messages);
    await ensureAccounts();
    const tried = new Set<string>();
    let last: UpstreamResult | undefined;
    for (let i = 0; i < this.maxAccounts; i++) {
      let token = i === 0 ? ctx.account?.access_token : undefined;
      let accountId = ctx.account?.email ?? 'ctx';
      if (!token) {
        const candidates = accountsPool.pick('aethyro.com', tried, 1);
        if (candidates.length === 0) break;
        const account = candidates[0];
        tried.add(account.id);
        token = account.access_token;
        accountId = account.id;
      }
      if (!token) break;
      const r = await supabaseInvoke(sbCfg, 'chat', { message: prompt, messages: req.messages }, token, { timeoutMs: ctx.timeoutMs ?? 120000 });
      const parsed = splitTrailingJson(r.text);
      const text = parsed.text.replace(/^data:\s*/gm, '').trim();
      const metaUsage = parsed.meta && typeof parsed.meta === 'object' ? (pickUsage(parsed.meta) ?? undefined) : undefined;
      if (r.status < 400 && text) {
        accountsPool.report(accountId, { ok: true, status: 200 });
        return { ok: true, status: 200, text, model: req.model, upstream: this.id, raw: r.text, account_id: accountId, usage: metaUsage ?? estimateUsage(prompt, text) };
      }
      accountsPool.report(accountId, { ok: false, status: r.status, error: 'chat ' + r.status });
      last = {
        ok: false, status: r.status, text: '', model: req.model, upstream: this.id, raw: r.text,
        retryable: r.status === 401 || r.status === 429 || r.status >= 500,
        detail: typeof parsed.meta?.error === 'string' ? (parsed.meta.error as string) : ('chat ' + r.status),
        account_id: accountId
      };
      if (!last.retryable) break;
    }
    return last ?? { ok: false, status: 503, text: '', model: req.model, upstream: this.id, retryable: true, detail: 'no aethyro account with token' };
  }
}

export class OpenAiCompatUpstream implements Upstream {
  id: string;
  label: string;
  host: string;
  models: string[];
  supportsStream = true;
  private baseUrl: string;
  private apiKey: string;
  private model: string;

  constructor(id: string, label: string, host: string, baseUrl: string, apiKey: string, model: string) {
    this.id = id;
    this.label = label;
    this.host = host;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.model = model;
    this.models = [model];
  }

  private payload(req: ChatRequest, stream: boolean): string {
    const body: Record<string, unknown> = {
      model: req.model && req.model !== 'auto' ? req.model : this.model,
      messages: req.messages,
      temperature: req.temperature,
      max_tokens: req.max_tokens,
      stream
    };
    if (stream) body.stream_options = { include_usage: true };
    return JSON.stringify(body);
  }

  async chat(req: ChatRequest, ctx: UpstreamContext): Promise<UpstreamResult> {
    try {
      const res = await fetch(this.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.apiKey },
        body: this.payload(req, false),
        signal: ctx.signal ?? AbortSignal.timeout(ctx.timeoutMs ?? 120000)
      });
      const raw = await res.text();
      if (!res.ok) return { ok: false, status: res.status, text: '', model: req.model, upstream: this.id, raw: raw.slice(0, 300), retryable: res.status === 429 || res.status >= 500 };
      const data = tryJson(raw) ?? {};
      const content = data?.choices?.[0]?.message?.content ?? '';
      const text = typeof content === 'string' ? content : JSON.stringify(content);
      return { ok: true, status: 200, text, model: data?.model ?? req.model, upstream: this.id, usage: pickUsage(data) ?? estimateUsage(messageText(req.messages), text) };
    } catch (e: any) {
      return { ok: false, status: 0, text: '', model: req.model, upstream: this.id, retryable: true, detail: String(e?.message ?? e) };
    }
  }

  async *chatStream(req: ChatRequest, ctx: UpstreamContext): AsyncIterable<StreamPiece> {
    const res = await fetch(this.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.apiKey, accept: 'text/event-stream' },
      body: this.payload(req, true),
      signal: ctx.signal ?? AbortSignal.timeout(ctx.timeoutMs ?? 120000)
    });
    if (!res.ok || !res.body) throw Object.assign(new Error('compat upstream ' + res.status), { status: res.status, retryable: res.status === 429 || res.status >= 500 });
    for await (const piece of ssePieces(res.body as ReadableStream<Uint8Array>)) yield piece;
  }
}
