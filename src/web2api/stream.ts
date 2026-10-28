import type { Usage } from './types.ts';

export function tryJson(s: string): any | undefined {
  try { return JSON.parse(s); } catch { return undefined; }
}

export function pickDelta(value: any): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(pickDelta).join('');
  if (!value || typeof value !== 'object') return '';
  const choices = value.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const c = choices[0];
    if (c && typeof c === 'object') {
      const d = (c as any).delta ?? (c as any).message;
      if (d) {
        const picked = pickDelta(d);
        if (picked) return picked;
      }
      if (typeof (c as any).text === 'string') return (c as any).text;
    }
  }
  for (const key of ['delta', 'content', 'text', 'response', 'output', 'token', 'chunk', 'message']) {
    if (key in value) {
      const picked = pickDelta((value as any)[key]);
      if (picked) return picked;
    }
  }
  return '';
}

export function pickUsage(value: any): Usage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidates: any[] = [value.usage, value.token_usage, value.usage_metadata, value.usageMetadata, value.tokens];
  for (const raw of candidates) {
    if (!raw || typeof raw !== 'object') continue;
    const prompt = raw.prompt_tokens ?? raw.input_tokens ?? raw.promptTokens ?? raw.inputTokens ?? raw.input;
    const completion = raw.completion_tokens ?? raw.output_tokens ?? raw.completionTokens ?? raw.outputTokens ?? raw.output;
    const total = raw.total_tokens ?? raw.totalTokens ?? raw.total;
    if (prompt === undefined && completion === undefined) continue;
    const p = Number(prompt ?? 0) || 0;
    const c = Number(completion ?? 0) || 0;
    return { prompt_tokens: p, completion_tokens: c, total_tokens: Number(total ?? p + c) || p + c };
  }
  const directPrompt = value.prompt_tokens ?? value.input_tokens;
  const directCompletion = value.completion_tokens ?? value.output_tokens;
  if (directPrompt !== undefined || directCompletion !== undefined) {
    const p = Number(directPrompt ?? 0) || 0;
    const c = Number(directCompletion ?? 0) || 0;
    return { prompt_tokens: p, completion_tokens: c, total_tokens: Number(value.total_tokens ?? p + c) || p + c };
  }
  return undefined;
}

export interface Piece {
  text?: string;
  usage?: Usage;
  model?: string;
}

export async function* iterSseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = (body as any).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        yield line;
      }
    }
    if (buffer.trim()) yield buffer.replace(/\r$/, '');
  } finally {
    try { await reader.cancel(); } catch {}
  }
}

export async function* sseDeltas(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  for await (const piece of ssePieces(body)) {
    if (piece.text) yield piece.text;
  }
}

export async function* ssePieces(body: ReadableStream<Uint8Array>): AsyncGenerator<Piece> {
  for await (const line of iterSseLines(body)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) continue;
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    const parsed = tryJson(payload);
    if (parsed === undefined) {
      yield { text: payload };
      continue;
    }
    const text = pickDelta(parsed);
    const usage = pickUsage(parsed);
    const model = typeof parsed?.model === 'string' ? parsed.model : undefined;
    if (text || usage || model) yield { text: text || undefined, usage, model };
  }
}

export async function* textDeltas(body: ReadableStream<Uint8Array>, chunkSize = 64): AsyncGenerator<string> {
  const reader = (body as any).getReader();
  const decoder = new TextDecoder();
  let carry = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      carry += decoder.decode(value, { stream: true });
      while (carry.length >= chunkSize) {
        const head = carry.slice(0, chunkSize);
        carry = carry.slice(chunkSize);
        yield head;
      }
    }
    carry += decoder.decode();
    if (carry) yield carry;
  } finally {
    try { await reader.cancel(); } catch {}
  }
}

export function jsonPath(value: any, path: string): any {
  if (!path) return value;
  let cur = value;
  for (const seg of path.split('.')) {
    if (cur == null) return undefined;
    const idx = Number(seg);
    cur = Number.isInteger(idx) && Array.isArray(cur) ? cur[idx] : (cur as any)[seg];
  }
  return cur;
}
