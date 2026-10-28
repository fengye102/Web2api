import { randomUUID } from 'node:crypto';
import type { ChatRequest, ChatMessage, Usage } from '../web2api/types.ts';

export const completionId = (): string => 'chatcmpl-' + randomUUID().replace(/-/g, '').slice(0, 26);
export const created = (): number => Math.floor(Date.now() / 1000);

export interface ValidationResult {
  ok: boolean;
  request?: ChatRequest;
  error?: string;
}

export function validateChatRequest(body: unknown): ValidationResult {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be a JSON object' };
  const obj = body as Record<string, unknown>;
  const messages = obj.messages;
  if (!Array.isArray(messages) || messages.length === 0) return { ok: false, error: 'messages[] is required and must be non-empty' };
  for (const m of messages) {
    if (!m || typeof m !== 'object') return { ok: false, error: 'each message must be an object' };
    const role = (m as any).role;
    if (!['system', 'user', 'assistant', 'tool'].includes(role)) return { ok: false, error: 'invalid message role: ' + String(role) };
    const content = (m as any).content;
    if (typeof content !== 'string' && !Array.isArray(content)) return { ok: false, error: 'message content must be string or array' };
  }
  if (obj.stream !== undefined && typeof obj.stream !== 'boolean') return { ok: false, error: 'stream must be boolean' };
  const streamOptions = obj.stream_options && typeof obj.stream_options === 'object'
    ? { include_usage: (obj.stream_options as any).include_usage === true }
    : undefined;
  const request: ChatRequest = {
    model: typeof obj.model === 'string' && obj.model ? obj.model : 'auto',
    messages: messages as ChatMessage[],
    stream: obj.stream === true,
    stream_options: streamOptions,
    temperature: typeof obj.temperature === 'number' ? obj.temperature : undefined,
    max_tokens: typeof obj.max_tokens === 'number' ? obj.max_tokens : undefined,
    top_p: typeof obj.top_p === 'number' ? obj.top_p : undefined,
    stop: obj.stop as ChatRequest['stop'],
    user: typeof obj.user === 'string' ? obj.user : undefined
  };
  return { ok: true, request };
}

export function applyAliases(request: ChatRequest, aliases: Record<string, string>): ChatRequest {
  const alias = aliases[request.model];
  if (!alias) return request;
  return { ...request, model: alias };
}

export function completionBody(id: string, model: string, text: string, extra: { upstream?: string; remaining?: number | null; usage?: Usage; account?: string } = {}) {
  const body: Record<string, unknown> = {
    id,
    object: 'chat.completion',
    created: created(),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop', logprobs: null }],
    usage: extra.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    system_fingerprint: extra.upstream ? 'w2a:' + extra.upstream : 'w2a'
  };
  if (extra.upstream) body.w2a_upstream = extra.upstream;
  if (extra.account) body.w2a_account = extra.account;
  if (extra.remaining !== undefined && extra.remaining !== null) body.w2a_remaining = extra.remaining;
  return body;
}

export function usageChunk(id: string, model: string, usage: Usage) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: created(),
    model,
    choices: [],
    usage
  };
}

export function chunkBody(id: string, model: string, opts: { role?: string; content?: string; finish?: string | null; upstream?: string }) {
  const delta: Record<string, unknown> = {};
  if (opts.role) delta.role = opts.role;
  if (opts.content) delta.content = opts.content;
  const body: Record<string, unknown> = {
    id,
    object: 'chat.completion.chunk',
    created: created(),
    model,
    choices: [{ index: 0, delta, finish_reason: opts.finish ?? null, logprobs: null }]
  };
  if (opts.upstream) body.w2a_upstream = opts.upstream;
  return body;
}

export function errorBody(message: string, type = 'invalid_request_error', extra: Record<string, unknown> = {}) {
  return { error: { message, type, param: null, code: null, ...extra } };
}

export function modelsBody(entries: { id: string; owner: string }[]) {
  return {
    object: 'list',
    data: entries.map((e) => ({ id: e.id, object: 'model', created: 0, owned_by: e.owner }))
  };
}
