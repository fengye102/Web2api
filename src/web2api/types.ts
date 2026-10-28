export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ContentPart { type: 'text' | 'image_url'; text?: string; image_url?: { url: string } }

export interface ChatMessage { role: Role; content: string | ContentPart[]; name?: string }

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface StreamOptions {
  include_usage?: boolean;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  stream_options?: StreamOptions;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stop?: string | string[];
  user?: string;
  [key: string]: unknown;
}

export interface UpstreamContext {
  signal?: AbortSignal;
  account?: { email: string; access_token?: string; cookies?: Record<string, string> };
  timeoutMs?: number;
  requestId?: string;
  includeUsage?: boolean;
}

export interface UpstreamResult {
  ok: boolean;
  status: number;
  text: string;
  model: string;
  upstream: string;
  raw?: string;
  retryable?: boolean;
  detail?: string;
  remaining?: number | null;
  usage?: Usage;
  account_id?: string;
}

export interface StreamPiece {
  text?: string;
  usage?: Usage;
  model?: string;
  account_id?: string;
}

export interface Upstream {
  id: string;
  label: string;
  host: string;
  models: string[];
  supportsStream: boolean;
  chat(req: ChatRequest, ctx: UpstreamContext): Promise<UpstreamResult>;
  chatStream?(req: ChatRequest, ctx: UpstreamContext): AsyncIterable<StreamPiece>;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let wide = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) > 0x2e80) wide += 1;
    else ascii += 1;
  }
  return Math.max(1, Math.ceil(ascii / 4 + wide / 1.6));
}

export function estimateUsage(promptText: string, completionText: string): Usage {
  const prompt_tokens = estimateTokens(promptText);
  const completion_tokens = estimateTokens(completionText);
  return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
}

export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    prompt_tokens: (a.prompt_tokens ?? 0) + (b.prompt_tokens ?? 0),
    completion_tokens: (a.completion_tokens ?? 0) + (b.completion_tokens ?? 0),
    total_tokens: (a.total_tokens ?? 0) + (b.total_tokens ?? 0)
  };
}

export function messageText(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const body = typeof m.content === 'string'
      ? m.content
      : m.content.map((p) => (p.type === 'text' ? p.text ?? '' : '[image]')).join('\n');
    if (m.role === 'system') parts.push('System: ' + body);
    else if (m.role === 'assistant') parts.push('Assistant: ' + body);
    else parts.push(body);
  }
  return parts.join('\n\n').trim();
}

export function systemText(messages: ChatMessage[]): string {
  return messages.filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => p.text ?? '').join('\n')))
    .join('\n')
    .trim();
}

export function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    return m.content.map((p) => (p.type === 'text' ? p.text ?? '' : '')).join('\n').trim();
  }
  return '';
}

export function splitTrailingJson(text: string): { text: string; meta?: Record<string, unknown> } {
  const trimmed = text.trimEnd();
  const open = trimmed.lastIndexOf('{"');
  if (open <= 0) return { text: trimmed };
  const tail = trimmed.slice(open);
  try {
    const meta = JSON.parse(tail) as Record<string, unknown>;
    if (typeof meta === 'object' && meta !== null) return { text: trimmed.slice(0, open).trimEnd(), meta };
  } catch { return { text: trimmed }; }
  return { text: trimmed };
}
