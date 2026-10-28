import { request } from '../core/http.ts';
import { lastUserText, messageText, systemText } from './types.ts';
import type { ChatMessage, ChatRequest, Upstream, UpstreamContext, UpstreamResult } from './types.ts';
import { ssePieces, textDeltas, jsonPath, tryJson, pickDelta, pickUsage } from './stream.ts';

export interface UpstreamSpec {
  id: string;
  label?: string;
  host?: string;
  enabled?: boolean;
  models: string[];
  base_url: string;
  chat_path: string;
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  response_kind?: 'sse-openai' | 'sse-delta' | 'json' | 'text';
  response_path?: string;
  model_map?: Record<string, string>;
  send_stream_options?: boolean;
  timeout_ms?: number;
  stream_by_default?: boolean;
  auth?: { header?: string; prefix?: string; token?: string };
}

const PLACEHOLDER = /{{\s*(model|prompt|messages|system|stream|user|session|token|max_tokens|temperature)\s*}}/g;

function renderValue(value: unknown, ctx: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const exact = value.match(/^{{\s*([a-z_]+)\s*}}$/i);
    if (exact && exact[1] in ctx) return ctx[exact[1]];
    return value.replace(PLACEHOLDER, (_m, key: string) => {
      const v = ctx[key.toLowerCase()];
      return v === undefined || v === null ? '' : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => renderValue(v, ctx));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = renderValue(v, ctx);
    return out;
  }
  return value;
}

export class DeclarativeUpstream implements Upstream {
  id: string;
  label: string;
  host: string;
  models: string[];
  supportsStream = true;
  spec: UpstreamSpec;

  constructor(spec: UpstreamSpec) {
    this.spec = spec;
    this.id = spec.id;
    this.label = spec.label ?? spec.id;
    this.host = spec.host ?? (() => { try { return new URL(spec.base_url).host; } catch { return spec.id; } })();
    this.models = spec.models.length ? spec.models : ['auto'];
  }

  private url(): string {
    const base = this.spec.base_url.replace(/\/$/, '');
    const p = this.spec.chat_path.startsWith('/') ? this.spec.chat_path : '/' + this.spec.chat_path;
    const url = new URL(base + p);
    for (const [k, v] of Object.entries(this.spec.query ?? {})) url.searchParams.set(k, v);
    return url.toString();
  }

  private model(req: ChatRequest): string {
    const mapped = this.spec.model_map?.[req.model];
    if (mapped) return mapped;
    if (this.models.includes(req.model)) return req.model;
    if (req.model && !/^(gpt|claude|gemini|o[34])/i.test(req.model)) return req.model;
    return this.models[0];
  }

  private payload(req: ChatRequest, streaming: boolean): unknown {
    const ctx: Record<string, unknown> = {
      model: this.model(req),
      prompt: lastUserText(req.messages),
      messages: req.messages as ChatMessage[],
      system: systemText(req.messages),
      stream: streaming,
      user: req.user ?? '',
      max_tokens: req.max_tokens ?? 1024,
      temperature: req.temperature ?? 0.7
    };
    const template = this.spec.body ?? {
      model: '{{model}}',
      messages: '{{messages}}',
      stream: '{{stream}}'
    };
    const rendered = renderValue(template, ctx) as Record<string, unknown>;
    if (streaming && this.spec.send_stream_options && rendered && typeof rendered === 'object' && !('stream_options' in rendered)) {
      rendered.stream_options = { include_usage: true };
    }
    return rendered;
  }

  private headers(req: ChatRequest): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'text/event-stream, application/json;q=0.9, */*;q=0.8',
      'content-type': 'application/json',
      ...(this.spec.headers ?? {})
    };
    const auth = this.spec.auth;
    if (auth?.token) headers[auth.header ?? 'authorization'] = (auth.prefix ?? 'Bearer ') + auth.token;
    if (req.user) headers['x-w2a-user'] = String(req.user);
    return headers;
  }

  private extract(response: any): string {
    if (this.spec.response_kind === 'json') return String(jsonPath(response, this.spec.response_path ?? 'choices.0.message.content') ?? '');
    if (typeof response === 'string') return response;
    const text = pickDelta(response);
    if (text) return text;
    return String(jsonPath(response, this.spec.response_path ?? '') ?? '');
  }

  private async fetchRaw(req: ChatRequest, ctx: UpstreamContext, streaming: boolean): Promise<Response> {
    const body = JSON.stringify(this.payload(req, streaming));
    const res = await fetch(this.url(), {
      method: this.spec.method ?? 'POST',
      headers: this.headers(req),
      body,
      signal: ctx.signal ?? AbortSignal.timeout(this.spec.timeout_ms ?? ctx.timeoutMs ?? 120000)
    });
    return res;
  }

  async chat(req: ChatRequest, ctx: UpstreamContext): Promise<UpstreamResult> {
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchRaw(req, ctx, false);
    } catch (e: any) {
      return { ok: false, status: 0, text: '', model: this.model(req), upstream: this.id, retryable: true, detail: String(e?.message ?? e) };
    }
    const ctype = res.headers.get('content-type') ?? '';
    if (!res.ok) {
      const raw = (await res.text()).slice(0, 400);
      return {
        ok: false, status: res.status, text: '', model: this.model(req), upstream: this.id, raw,
        retryable: res.status === 429 || res.status === 401 || res.status === 403 || res.status >= 500,
        detail: 'upstream ' + res.status
      };
    }
    const wantsSse = this.spec.response_kind === 'sse-openai' || this.spec.response_kind === 'sse-delta';
    const looksJson = ctype.includes('json');
    if (ctype.includes('event-stream') || (wantsSse && !looksJson)) {
      let text = '';
      let usage = undefined as UpstreamResult['usage'];
      let streamModel = this.model(req);
      for await (const piece of ssePieces(res.body as ReadableStream<Uint8Array>)) {
        if (piece.text) text += piece.text;
        if (piece.usage) usage = piece.usage;
        if (piece.model) streamModel = piece.model;
      }
      return { ok: text.trim().length > 0, status: 200, text: text.trim(), model: streamModel, upstream: this.id, usage, detail: 'stream collected in ' + (Date.now() - started) + 'ms' };
    }
    const raw = await res.text();
    if (this.spec.response_kind === 'text' || !ctype.includes('json')) {
      return { ok: raw.trim().length > 0, status: 200, text: raw.trim(), model: this.model(req), upstream: this.id };
    }
    const parsed = tryJson(raw);
    const text = parsed === undefined ? raw : this.extract(parsed);
    return { ok: text.trim().length > 0, status: 200, text: text.trim(), model: this.model(req), upstream: this.id, raw: raw.slice(0, 400), usage: parsed === undefined ? undefined : pickUsage(parsed) };
  }

  async *chatStream(req: ChatRequest, ctx: UpstreamContext): AsyncIterable<StreamPiece> {
    const res = await this.fetchRaw(req, ctx, true);
    if (!res.ok || !res.body) {
      const raw = await res.text().catch(() => '');
      throw Object.assign(new Error('upstream ' + res.status), { status: res.status, raw: raw.slice(0, 300), retryable: res.status === 429 || res.status === 401 || res.status === 403 || res.status >= 500 });
    }
    const ctype = res.headers.get('content-type') ?? '';
    const wantsSse = this.spec.response_kind === 'sse-openai' || this.spec.response_kind === 'sse-delta';
    const useSse = ctype.includes('event-stream') || (wantsSse && !ctype.includes('json'));
    if (useSse) {
      for await (const piece of ssePieces(res.body as ReadableStream<Uint8Array>)) {
        if (piece.text || piece.usage || piece.model) yield { text: piece.text, usage: piece.usage, model: piece.model };
      }
      return;
    }
    if (ctype.includes('json')) {
      const raw = await res.text();
      const parsed = tryJson(raw);
      const text = parsed === undefined ? raw : this.extract(parsed);
      if (text) yield { text };
      const usage = parsed === undefined ? undefined : pickUsage(parsed);
      if (usage) yield { usage };
      return;
    }
    for await (const piece of textDeltas(res.body as ReadableStream<Uint8Array>)) yield { text: piece };
  }
}
