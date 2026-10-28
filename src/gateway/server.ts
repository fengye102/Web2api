import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { AethyroAccountUpstream, AethyroTrialUpstream, EchoUpstream, OpenAiCompatUpstream, UhelpUpstream, accountsPool } from '../web2api/upstreams.ts';
import { DeclarativeUpstream } from '../web2api/declarative.ts';
import type { Upstream } from '../web2api/types.ts';
import { UpstreamPool } from '../pool/pool.ts';
import { Router } from './router.ts';
import { loadConfig, ensureConfigFile, redactConfig } from './config.ts';
import type { GatewayConfig } from './config.ts';
import { Logger } from './logger.ts';
import { RateLimiter, ConcurrencyGate } from './limiter.ts';
import { applyAliases, chunkBody, completionBody, completionId, errorBody, modelsBody, usageChunk, validateChatRequest } from './openai.ts';

export interface GatewayHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
  stats: () => GatewayStats;
}

export interface GatewayStats {
  started_at: string;
  requests: number;
  ok: number;
  failed: number;
  rejected: number;
  in_flight: number;
  bytes_out: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  by_endpoint: Record<string, number>;
  by_upstream: Record<string, { wins: number; losses: number; tokens: number; accounts: Record<string, number> }>;
}

function buildUpstreams(cfg: GatewayConfig): Upstream[] {
  const list: Upstream[] = [];
  for (const spec of cfg.upstreams) list.push(new DeclarativeUpstream(spec));
  const compat = process.env.W2A_UPSTREAM_BASE;
  if (compat) {
    list.push(new OpenAiCompatUpstream(
      process.env.W2A_UPSTREAM_ID ?? 'compat',
      'OpenAI-compatible upstream',
      'compat',
      compat,
      process.env.W2A_UPSTREAM_KEY ?? '',
      process.env.W2A_UPSTREAM_MODEL ?? 'gpt-4o-mini'
    ));
  }
  if (cfg.builtin.uhelp) list.push(new UhelpUpstream());
  if (cfg.builtin.aethyro_account) list.push(new AethyroAccountUpstream());
  if (cfg.builtin.aethyro_trial) list.push(new AethyroTrialUpstream());
  if (cfg.builtin.echo) list.push(new EchoUpstream());
  return list;
}

function isLoopback(req: http.IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function clientKey(req: http.IncomingMessage, apiKey: string): string {
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Bearer ')) return 'key:' + auth.slice(7).slice(0, 12);
  const x = req.headers['x-api-key'];
  if (typeof x === 'string') return 'key:' + x.slice(0, 12);
  return 'ip:' + (apiKey ? 'anon' : (req.socket.remoteAddress ?? 'unknown'));
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<{ ok: boolean; body?: string; error?: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.from(chunk as Buffer);
    size += buf.length;
    if (size > limit) return { ok: false, error: 'request body too large (limit ' + limit + ' bytes)' };
    chunks.push(buf);
  }
  return { ok: true, body: Buffer.concat(chunks).toString('utf8') };
}

export async function startGateway(overrides: Partial<GatewayConfig> = {}): Promise<GatewayHandle> {
  let cfg = await ensureConfigFile();
  if (Object.keys(overrides).length) cfg = await loadConfig(overrides);

  const logger = new Logger({ level: cfg.log_level, file: cfg.log_file });
  let upstreams = buildUpstreams(cfg);
  const pool = new UpstreamPool();
  await pool.load();
  await accountsPool.load();
  let router = new Router(upstreams, pool, cfg, logger, accountsPool);

  const limiter = new RateLimiter(cfg.limits.rpm);
  const gate = new ConcurrencyGate(cfg.limits.max_concurrency);
  const stats: GatewayStats = {
    started_at: new Date().toISOString(),
    requests: 0, ok: 0, failed: 0, rejected: 0, in_flight: 0, bytes_out: 0,
    prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
    by_endpoint: {}, by_upstream: {}
  };

  const tally = (upstream: string, usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }, account?: string): void => {
    if (usage) {
      stats.prompt_tokens += usage.prompt_tokens ?? 0;
      stats.completion_tokens += usage.completion_tokens ?? 0;
      stats.total_tokens += usage.total_tokens ?? 0;
    }
    const row = stats.by_upstream[upstream] ?? (stats.by_upstream[upstream] = { wins: 0, losses: 0, tokens: 0, accounts: {} });
    row.tokens += usage?.total_tokens ?? 0;
    if (account) row.accounts[account] = (row.accounts[account] ?? 0) + 1;
  };

  const cors = (res: http.ServerResponse): void => {
    res.setHeader('access-control-allow-origin', cfg.cors_origin);
    res.setHeader('access-control-allow-headers', 'authorization, content-type, x-api-key, x-request-id');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-expose-headers', 'x-request-id, x-upstream, x-w2a-attempts');
  };

  const sendJson = (res: http.ServerResponse, status: number, payload: unknown, extra: Record<string, string> = {}): void => {
    const body = JSON.stringify(payload);
    cors(res);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), ...extra });
    res.end(body);
    stats.bytes_out += Buffer.byteLength(body);
  };

  const authorized = (req: http.IncomingMessage): boolean => {
    if (!cfg.api_key) return isLoopback(req);
    const auth = req.headers.authorization ?? '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const headerKey = typeof req.headers['x-api-key'] === 'string' ? String(req.headers['x-api-key']) : '';
    return bearer === cfg.api_key || headerKey === cfg.api_key;
  };

  const handleChat = async (req: http.IncomingMessage, res: http.ServerResponse, requestId: string): Promise<void> => {
    const read = await readBody(req, cfg.limits.max_body_bytes);
    if (!read.ok) {
      stats.rejected += 1;
      sendJson(res, 413, errorBody(read.error ?? 'body too large'));
      return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(read.body ?? '{}'); } catch { sendJson(res, 400, errorBody('invalid JSON body')); return; }
    const valid = validateChatRequest(parsed);
    if (!valid.ok || !valid.request) {
      stats.rejected += 1;
      sendJson(res, 400, errorBody(valid.error ?? 'invalid request'));
      return;
    }
    const url = new URL(req.url ?? '/', 'http://' + (req.headers.host ?? 'localhost'));
    const requested = url.searchParams.get('upstream') ?? (parsed as any).upstream ?? cfg.default_upstream;
    const request = applyAliases(valid.request, cfg.model_aliases);

    const abort = new AbortController();
    req.on('close', () => abort.abort());
    const ctx = { signal: abort.signal, timeoutMs: cfg.limits.request_timeout_ms, requestId };

    stats.requests += 1;
    stats.by_endpoint['/v1/chat/completions'] = (stats.by_endpoint['/v1/chat/completions'] ?? 0) + 1;
    const release = await gate.acquire();
    stats.in_flight += 1;
    const started = Date.now();
    try {
      if (!request.stream) {
        const { result, tried } = await router.complete(request, ctx, requested);
        const attempts = tried.map((t) => t.upstream + ':' + t.status).join(',');
        if (!result || !result.ok) {
          stats.failed += 1;
          sendJson(res, 502, errorBody(
            'all upstreams failed: ' + (result?.detail ?? 'no attempt succeeded'),
            'upstream_error',
            { upstream: result?.upstream ?? null, tried }
          ), { 'x-request-id': requestId, 'x-w2a-attempts': attempts });
          return;
        }
        stats.ok += 1;
        stats.by_upstream[result.upstream] = stats.by_upstream[result.upstream] ?? { wins: 0, losses: 0, tokens: 0, accounts: {} };
        stats.by_upstream[result.upstream].wins += 1;
        tally(result.upstream, result.usage, result.account_id);
        logger.info('chat ok', { requestId, upstream: result.upstream, model: request.model, account: result.account_id, ms: Date.now() - started, chars: result.text.length, usage: result.usage });
        sendJson(res, 200, completionBody(completionId(), request.model, result.text, { upstream: result.upstream, remaining: result.remaining ?? null, usage: result.usage, account: result.account_id }), {
          'x-request-id': requestId,
          'x-upstream': result.upstream,
          'x-w2a-attempts': attempts
        });
        return;
      }

      cors(res);
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-request-id': requestId,
        'x-accel-buffering': 'no'
      });
      const id = completionId();
      let closed = false;
      const ping = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, 15000);
      const write = (obj: unknown): void => {
        const line = 'data: ' + JSON.stringify(obj) + '\n\n';
        stats.bytes_out += line.length;
        if (!closed) res.write(line);
      };

      write(chunkBody(id, request.model, { role: 'assistant' }));
      let upstreamId = 'none';
      let text = '';
      try {
        for await (const event of router.stream(request, ctx, requested)) {
          if (event.kind === 'attempt') {
            upstreamId = event.upstream;
          } else if (event.kind === 'delta') {
            text += event.text;
            write(chunkBody(id, request.model, { content: event.text, upstream: event.upstream }));
          } else if (event.kind === 'usage') {
            if (request.stream_options?.include_usage) write(usageChunk(id, request.model, event.usage));
          } else if (event.kind === 'done') {
            upstreamId = event.upstream;
            write(chunkBody(id, request.model, { finish: 'stop', upstream: event.upstream }));
            if (request.stream_options?.include_usage) write(usageChunk(id, request.model, event.usage));
            write('[DONE]');
            stats.ok += 1;
            stats.by_upstream[event.upstream] = stats.by_upstream[event.upstream] ?? { wins: 0, losses: 0, tokens: 0, accounts: {} };
            stats.by_upstream[event.upstream].wins += 1;
            tally(event.upstream, event.usage, event.account);
            logger.info('stream ok', { requestId, upstream: event.upstream, account: event.account, chars: event.text.length, usage: event.usage, ms: Date.now() - started });
            return;
          } else if (event.kind === 'error') {
            logger.warn('stream attempt failed', { requestId, upstream: event.upstream, status: event.status, detail: event.detail });
            if (!event.retryable && text.length === 0) {
              write(errorBody(event.detail, 'upstream_error', { upstream: event.upstream, status: event.status }));
              write('[DONE]');
              stats.failed += 1;
              return;
            }
          }
        }
        if (text.length === 0) {
          write(errorBody('all upstreams failed', 'upstream_error', { tried: upstreamId }));
          stats.failed += 1;
        } else {
          write(chunkBody(id, request.model, { finish: 'stop' }));
          stats.ok += 1;
        }
        write('[DONE]');
      } finally {
        clearInterval(ping);
        closed = true;
        res.end();
      }
    } finally {
      stats.in_flight -= 1;
      release();
    }
  };

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const requestId = (typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : '') || 'w2a-' + randomUUID().slice(0, 12);
    const url = new URL(req.url ?? '/', 'http://' + (req.headers.host ?? 'localhost'));
    if (req.method === 'OPTIONS') {
      cors(res);
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === '/health' || url.pathname === '/') {
      sendJson(res, 200, {
        ok: true,
        service: 'web2api-gateway',
        request_id: requestId,
        upstreams: router.list().map((u) => ({ id: u.id, label: u.label, models: u.models, streaming: u.supportsStream })),
        pool: pool.snapshot(),
        accounts: router.accountSummary(),
        limits: { ...cfg.limits, rate: limiter.snapshot(), gate: gate.snapshot() },
        stats
      }, { 'x-request-id': requestId });
      return;
    }
    if (!authorized(req)) {
      stats.rejected += 1;
      sendJson(res, 401, errorBody('invalid api key', 'authentication_error'), { 'x-request-id': requestId });
      return;
    }
    if (url.pathname === '/v1/models') {
      const entries: { id: string; owner: string }[] = [];
      const seen = new Set<string>();
      for (const u of router.list()) {
        for (const m of u.models) {
          if (seen.has(m)) continue;
          seen.add(m);
          entries.push({ id: m, owner: u.id });
        }
      }
      for (const [alias, target] of Object.entries(cfg.model_aliases)) {
        if (seen.has(alias)) continue;
        seen.add(alias);
        entries.push({ id: alias, owner: 'alias->' + target });
      }
      sendJson(res, 200, modelsBody(entries), { 'x-request-id': requestId });
      return;
    }
    if (url.pathname === '/v1/stats') {
      sendJson(res, 200, { stats, pool: pool.snapshot(), accounts: router.accountSummary(), rate: limiter.snapshot(), gate: gate.snapshot() }, { 'x-request-id': requestId });
      return;
    }
    if (url.pathname === '/admin/config') {
      sendJson(res, 200, redactConfig(cfg), { 'x-request-id': requestId });
      return;
    }
    if (url.pathname === '/admin/logs') {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
      sendJson(res, 200, { entries: logger.tail(limit) }, { 'x-request-id': requestId });
      return;
    }
    if (url.pathname === '/admin/reload' && req.method === 'POST') {
      cfg = await loadConfig(overrides);
      logger.setLevel(cfg.log_level);
      upstreams = buildUpstreams(cfg);
      await accountsPool.refreshAccounts();
      router = new Router(upstreams, pool, cfg, logger, accountsPool);
      logger.info('config reloaded', { upstreams: upstreams.map((u) => u.id) });
      sendJson(res, 200, { ok: true, upstreams: upstreams.map((u) => u.id) }, { 'x-request-id': requestId });
      return;
    }
    if (url.pathname === '/v1/chat/completions') {
      if (req.method !== 'POST') {
        sendJson(res, 405, errorBody('method not allowed', 'invalid_request_error'), { allow: 'POST' });
        return;
      }
      const verdict = limiter.check(clientKey(req, cfg.api_key));
      if (!verdict.ok) {
        stats.rejected += 1;
        sendJson(res, 429, errorBody('rate limit exceeded', 'rate_limit_error', { retry_after_ms: verdict.retryAfterMs }), { 'retry-after': String(Math.ceil(verdict.retryAfterMs / 1000)) });
        return;
      }
      await handleChat(req, res, requestId);
      return;
    }
    sendJson(res, 404, errorBody('unknown endpoint: ' + url.pathname, 'invalid_request_error'), { 'x-request-id': requestId });
  };

  const server = http.createServer((req, res) => {
    handler(req, res).catch((e: any) => {
      logger.error('unhandled', { message: String(e?.message ?? e), stack: String(e?.stack ?? '').split('\n').slice(0, 4).join(' | ') });
      try { if (!res.headersSent) sendJson(res, 500, errorBody(String(e?.message ?? e), 'internal_error')); else res.end(); } catch {}
    });
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;

  await new Promise<void>((resolve) => server.listen(cfg.port, cfg.host, () => resolve()));
  const url = 'http://' + cfg.host + ':' + cfg.port;
  logger.info('gateway listening', { url, upstreams: upstreams.map((u) => u.id), limits: cfg.limits });

  return {
    url,
    port: cfg.port,
    stats: () => stats,
    close: async () => {
      await pool.save();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
