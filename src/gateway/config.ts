import { readJson, writeJson, exists } from '../core/store.ts';
import type { UpstreamSpec } from '../web2api/declarative.ts';

export interface LimitsConfig {
  rpm: number;
  max_concurrency: number;
  max_body_bytes: number;
  request_timeout_ms: number;
  upstream_attempts: number;
  account_attempts: number;
}

export interface BuiltinToggle {
  uhelp: boolean;
  aethyro_account: boolean;
  aethyro_trial: boolean;
  echo: boolean;
}

export interface GatewayConfig {
  port: number;
  host: string;
  api_key: string;
  default_upstream: string;
  cors_origin: string;
  model_aliases: Record<string, string>;
  limits: LimitsConfig;
  builtin: BuiltinToggle;
  upstreams: UpstreamSpec[];
  log_file: string;
  log_level: 'debug' | 'info' | 'warn' | 'error';
}

export const CONFIG_PATH = 'data/config.json';

export const DEFAULT_CONFIG: GatewayConfig = {
  port: 8787,
  host: '127.0.0.1',
  api_key: '',
  default_upstream: 'echo',
  cors_origin: '*',
  model_aliases: {
    'gpt-4o': 'claude-haiku-4-5-20251001',
    'gpt-4o-mini': 'claude-haiku-4-5-20251001',
    'claude-3-5-sonnet': 'claude-sonnet-4-6'
  },
  limits: {
    rpm: 120,
    max_concurrency: 8,
    max_body_bytes: 2 * 1024 * 1024,
    request_timeout_ms: 180000,
    upstream_attempts: 3,
    account_attempts: 3
  },
  builtin: {
    uhelp: true,
    aethyro_account: true,
    aethyro_trial: false,
    echo: true
  },
  upstreams: [
    {
      id: 'example-site',
      label: 'example.com 反代（把 cookie / 端点换成你的站点即可）',
      enabled: false,
      models: ['claude-haiku-4-5-20251001'],
      base_url: 'https://example.com',
      chat_path: '/api/chat',
      method: 'POST',
      headers: {
        origin: 'https://example.com',
        referer: 'https://example.com/chat',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
      },
      body: { model: '{{model}}', messages: '{{messages}}', stream: '{{stream}}' },
      response_kind: 'sse-openai',
      stream_by_default: true,
      timeout_ms: 120000
    }
  ],
  log_file: 'data/logs/gateway.log',
  log_level: 'info'
};

function mergeDeep<T>(base: T, patch: any): T {
  if (patch === undefined || patch === null) return base;
  if (Array.isArray(base) || typeof base !== 'object') return (patch as T) ?? base;
  const out: any = { ...(base as any) };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in (base as any) ? mergeDeep((base as any)[k], v) : v;
  }
  return out as T;
}

export async function ensureConfigFile(): Promise<GatewayConfig> {
  if (!(await exists(CONFIG_PATH))) await writeJson(CONFIG_PATH, DEFAULT_CONFIG);
  return loadConfig();
}

export async function loadConfig(overrides: Partial<GatewayConfig> = {}): Promise<GatewayConfig> {
  const stored = (await readJson<Partial<GatewayConfig>>(CONFIG_PATH)) ?? {};
  let cfg = mergeDeep(DEFAULT_CONFIG, stored);
  if (process.env.W2A_PORT) cfg.port = Number(process.env.W2A_PORT);
  if (process.env.W2A_HOST) cfg.host = process.env.W2A_HOST;
  if (process.env.W2A_KEY) cfg.api_key = process.env.W2A_KEY;
  if (process.env.W2A_DEFAULT_UPSTREAM) cfg.default_upstream = process.env.W2A_DEFAULT_UPSTREAM;
  if (process.env.W2A_LOG_LEVEL) cfg.log_level = process.env.W2A_LOG_LEVEL as GatewayConfig['log_level'];
  cfg = mergeDeep(cfg, overrides);
  cfg.upstreams = (cfg.upstreams ?? []).filter((u) => u && u.id && u.enabled !== false);
  return cfg;
}

export function redactConfig(cfg: GatewayConfig): GatewayConfig {
  const clone: GatewayConfig = JSON.parse(JSON.stringify(cfg));
  if (clone.api_key) clone.api_key = '***' + clone.api_key.slice(-4);
  for (const u of clone.upstreams) {
    if (u.auth?.token) u.auth.token = '***' + u.auth.token.slice(-4);
    if (u.headers) {
      for (const [k, v] of Object.entries(u.headers)) {
        if (/authorization|cookie|token|key/i.test(k)) u.headers[k] = '***' + String(v).slice(-4);
      }
    }
  }
  return clone;
}
