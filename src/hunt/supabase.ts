import { postJson, getJson } from '../core/http.ts';
import { truncate } from '../core/util.ts';

export interface SupabaseAuthResult {
  status: number;
  email: string;
  access_token?: string;
  refresh_token?: string;
  user_id?: string;
  needs_confirm: boolean;
  message: string;
}

export interface SupabaseCfg { url: string; anon_key: string }

export function supabaseHeaders(cfg: SupabaseCfg, jwt?: string): Record<string, string> {
  return {
    apikey: cfg.anon_key,
    authorization: 'Bearer ' + (jwt ?? cfg.anon_key),
    'content-type': 'application/json'
  };
}

export async function supabaseSettings(cfg: SupabaseCfg): Promise<any | undefined> {
  return getJson<any>(cfg.url + '/auth/v1/settings', { headers: { apikey: cfg.anon_key }, timeoutMs: 20000 });
}

export async function supabaseSignup(cfg: SupabaseCfg, email: string, password: string): Promise<SupabaseAuthResult> {
  const r = await postJson<any>(cfg.url + '/auth/v1/signup', { email, password }, { headers: supabaseHeaders(cfg), timeoutMs: 25000 });
  const data = r.data ?? {};
  const session = data.session ?? data;
  return {
    status: r.status,
    email,
    access_token: session?.access_token,
    refresh_token: session?.refresh_token,
    user_id: data.user?.id ?? data.id,
    needs_confirm: r.status < 300 && !session?.access_token,
    message: r.status < 300 ? (session?.access_token ? 'session issued' : 'confirmation required') : truncate(r.text, 220)
  };
}

export async function supabaseVerifyCode(cfg: SupabaseCfg, email: string, token: string): Promise<SupabaseAuthResult> {
  const r = await postJson<any>(cfg.url + '/auth/v1/verify', { type: 'signup', token, email }, { headers: supabaseHeaders(cfg), timeoutMs: 25000 });
  const session = r.data ?? {};
  return {
    status: r.status,
    email,
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    user_id: session.user?.id,
    needs_confirm: !session.access_token,
    message: r.status < 300 ? (session.access_token ? 'verified' : 'no session returned') : truncate(r.text, 220)
  };
}

export async function supabasePasswordGrant(cfg: SupabaseCfg, email: string, password: string): Promise<SupabaseAuthResult> {
  const r = await postJson<any>(cfg.url + '/auth/v1/token?grant_type=password', { email, password }, { headers: supabaseHeaders(cfg), timeoutMs: 25000 });
  const d = r.data ?? {};
  return {
    status: r.status,
    email,
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    user_id: d.user?.id,
    needs_confirm: r.status === 400 && /not confirmed/i.test(r.text),
    message: r.status < 300 ? 'session issued' : truncate(r.text, 220)
  };
}

export async function supabaseRefresh(cfg: SupabaseCfg, refresh_token: string): Promise<SupabaseAuthResult> {
  const r = await postJson<any>(cfg.url + '/auth/v1/token?grant_type=refresh_token', { refresh_token }, { headers: supabaseHeaders(cfg), timeoutMs: 25000 });
  const d = r.data ?? {};
  return {
    status: r.status,
    email: '',
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    user_id: d.user?.id,
    needs_confirm: false,
    message: r.status < 300 ? 'refreshed' : truncate(r.text, 200)
  };
}

export async function supabaseInvoke(cfg: SupabaseCfg, fn: string, body: unknown, jwt?: string, opts: { timeoutMs?: number } = {}): Promise<{ status: number; text: string; headers: Headers }> {
  const r = await postJson<any>(cfg.url + '/functions/v1/' + fn, body, { headers: supabaseHeaders(cfg, jwt), timeoutMs: opts.timeoutMs ?? 90000 });
  return { status: r.status, text: r.text, headers: r.headers };
}
