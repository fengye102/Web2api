import type { ChatRequest, StreamPiece, Upstream, UpstreamContext, UpstreamResult, Usage } from '../web2api/types.ts';
import { addUsage, estimateUsage, messageText } from '../web2api/types.ts';
import { AccountPool } from '../pool/accounts.ts';
import { UpstreamPool } from '../pool/pool.ts';
import type { Logger } from './logger.ts';
import type { GatewayConfig } from './config.ts';

export interface AttemptRecord {
  upstream: string;
  status: number;
  ok: boolean;
  detail?: string;
  ms: number;
}

export interface CompleteOutcome {
  result?: UpstreamResult;
  tried: AttemptRecord[];
}

export type StreamEvent =
  | { kind: 'attempt'; upstream: string }
  | { kind: 'delta'; upstream: string; text: string; account?: string }
  | { kind: 'usage'; upstream: string; usage: Usage }
  | { kind: 'error'; upstream: string; status: number; detail: string; retryable: boolean }
  | { kind: 'done'; upstream: string; text: string; usage: Usage; account?: string };

export class Router {
  private upstreams: Upstream[];
  private pool: UpstreamPool;
  private accounts: AccountPool | undefined;
  private cfg: GatewayConfig;
  private logger: Logger;

  constructor(upstreams: Upstream[], pool: UpstreamPool, cfg: GatewayConfig, logger: Logger, accounts?: AccountPool) {
    this.upstreams = upstreams;
    this.pool = pool;
    this.cfg = cfg;
    this.logger = logger;
    this.accounts = accounts;
  }

  accountSummary(): unknown[] {
    return this.accounts ? this.accounts.summary() : [];
  }

  list(): Upstream[] {
    return this.upstreams;
  }

  get(id: string): Upstream | undefined {
    return this.upstreams.find((u) => u.id === id);
  }

  chain(requested?: string): Upstream[] {
    const ids = this.upstreams.map((u) => u.id);
    const now = Date.now();
    const usable = this.pool.order(ids)
      .map((id) => this.upstreams.find((u) => u.id === id))
      .filter((u): u is Upstream => Boolean(u))
      .filter((u) => {
        const entry = this.pool.get(u.id);
        if (entry.state === 'dead') return false;
        if (entry.state === 'cooling' && entry.cooldown_until > now) return false;
        return true;
      });
    const preferred = requested ? usable.filter((u) => u.id === requested) : [];
    const rest = usable.filter((u) => !preferred.some((p) => p.id === u.id));
    const ordered = [...preferred, ...rest];
    return ordered.slice(0, Math.max(1, this.cfg.limits.upstream_attempts));
  }

  private decorate(result: UpstreamResult, ms: number): AttemptRecord {
    return { upstream: result.upstream, status: result.status, ok: result.ok, detail: result.detail, ms };
  }

  private async record(result: UpstreamResult, ms: number): Promise<void> {
    this.pool.record(result.upstream, {
      ok: result.ok,
      status: result.status,
      remaining: typeof result.remaining === 'number' ? result.remaining : undefined,
      error: result.ok ? undefined : (result.detail ?? (result.raw ?? '').slice(0, 160))
    });
    await this.pool.save();
    const entry = { upstream: result.upstream, status: result.status, ok: result.ok, ms, detail: result.detail };
    if (result.ok) this.logger.info('upstream ok', entry);
    else this.logger.warn('upstream fail', entry);
  }

  async complete(req: ChatRequest, ctx: UpstreamContext, requested?: string): Promise<CompleteOutcome> {
    const tried: AttemptRecord[] = [];
    for (const upstream of this.chain(requested)) {
      const started = Date.now();
      let result: UpstreamResult;
      try {
        result = await upstream.chat(req, ctx);
      } catch (e: any) {
        result = { ok: false, status: 0, text: '', model: req.model, upstream: upstream.id, retryable: true, detail: String(e?.message ?? e) };
      }
      const ms = Date.now() - started;
      if (result.ok && !result.usage) result.usage = estimateUsage(messageText(req.messages), result.text);
      tried.push(this.decorate(result, ms));
      await this.record(result, ms);
      if (result.ok && result.text.trim().length > 0) return { result, tried };
      if (!result.retryable) return { result, tried };
    }
    return { tried };
  }

  async *stream(req: ChatRequest, ctx: UpstreamContext, requested?: string): AsyncIterable<StreamEvent> {
    const chain = this.chain(requested);
    let sawDelta = false;
    const collected: string[] = [];
    for (const upstream of chain) {
      const started = Date.now();
      yield { kind: 'attempt', upstream: upstream.id };
      if (!upstream.chatStream) {
        let result: UpstreamResult;
        try {
          result = await upstream.chat(req, ctx);
        } catch (e: any) {
          result = { ok: false, status: 0, text: '', model: req.model, upstream: upstream.id, retryable: true, detail: String(e?.message ?? e) };
        }
        const ms = Date.now() - started;
        if (result.ok && !result.usage) result.usage = estimateUsage(messageText(req.messages), result.text);
        await this.record(result, ms);
        if (result.ok && result.text.trim()) {
          sawDelta = true;
          collected.push(result.text);
          yield { kind: 'delta', upstream: upstream.id, text: result.text, account: result.account_id };
          yield { kind: 'done', upstream: upstream.id, text: collected.join(''), usage: result.usage ?? estimateUsage(messageText(req.messages), collected.join('')), account: result.account_id };
          return;
        }
        yield { kind: 'error', upstream: upstream.id, status: result.status, detail: result.detail ?? 'no text', retryable: Boolean(result.retryable) };
        if (!result.retryable) return;
        continue;
      }
      let emitted = false;
      let usage: Usage | undefined;
      let account: string | undefined;
      try {
        for await (const piece of upstream.chatStream(req, ctx)) {
          if (!piece) continue;
          if (piece.account_id) account = piece.account_id;
          if (piece.usage) usage = addUsage(usage, piece.usage);
          if (!piece.text) continue;
          emitted = true;
          sawDelta = true;
          collected.push(piece.text);
          yield { kind: 'delta', upstream: upstream.id, text: piece.text, account };
        }
        const ms = Date.now() - started;
        const finalUsage = usage ?? estimateUsage(messageText(req.messages), collected.join(''));
        const okResult: UpstreamResult = { ok: true, status: 200, text: collected.join(''), model: req.model, upstream: upstream.id, usage: finalUsage, account_id: account };
        await this.record(okResult, ms);
        yield { kind: 'done', upstream: upstream.id, text: collected.join(''), usage: finalUsage, account };
        return;
      } catch (e: any) {
        const ms = Date.now() - started;
        const status = typeof e?.status === 'number' ? e.status : 0;
        const retryable = e?.retryable !== false && (status === 0 || status === 401 || status === 402 || status === 429 || status >= 500);
        const failed: UpstreamResult = { ok: false, status, text: '', model: req.model, upstream: upstream.id, retryable, detail: String(e?.message ?? e) };
        if (emitted) {
          const partialUsage = usage ?? estimateUsage(messageText(req.messages), collected.join(''));
          await this.record({ ...failed, ok: true, status: 200, usage: partialUsage }, ms);
          this.logger.warn('stream aborted mid-flight', { upstream: upstream.id, detail: failed.detail });
          yield { kind: 'done', upstream: upstream.id, text: collected.join(''), usage: partialUsage, account };
          return;
        }
        await this.record(failed, ms);
        yield { kind: 'error', upstream: upstream.id, status, detail: failed.detail ?? 'stream error', retryable };
        if (!retryable) return;
      }
    }
    if (!sawDelta) yield { kind: 'error', upstream: 'none', status: 502, detail: 'all upstreams failed', retryable: false };
  }
}
