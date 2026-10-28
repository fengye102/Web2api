import type { TempMail, Mailbox } from '../mail/tempmail.ts';
import type { SiteConfig } from './discover.ts';
import { postJson, request } from '../core/http.ts';
import { CookieJar } from '../core/http.ts';
import { truncate } from '../core/util.ts';
import * as sb from './supabase.ts';

export interface AccountRecord {
  id: string;
  host: string;
  label: string;
  email: string;
  password: string;
  mail_provider: string;
  access_token?: string;
  refresh_token?: string;
  user_id?: string;
  cookies?: Record<string, string>;
  status: 'active' | 'needs_confirm' | 'failed';
  note: string;
  created_at: string;
  last_used?: string;
}

export interface SignupOptions {
  password?: string;
  confirmTimeoutMs?: number;
  skipConfirm?: boolean;
  retry429?: number;
  retryDelayMs?: number;
}

export interface SignupOutcome {
  ok: boolean;
  status: AccountRecord['status'];
  message: string;
  account?: AccountRecord;
  mailbox?: Mailbox;
}

export interface CreditProbe { ok: boolean; detail: string }

export interface SiteAdapter {
  host: string;
  label: string;
  signup(mail: TempMail, cfg: SiteConfig, opts: SignupOptions): Promise<SignupOutcome>;
  confirm?(account: AccountRecord, mail: TempMail, cfg: SiteConfig, opts: SignupOptions): Promise<SignupOutcome>;
  probeCredits(account: AccountRecord, cfg: SiteConfig): Promise<CreditProbe>;
  chatProbe?(account: AccountRecord, cfg: SiteConfig): Promise<CreditProbe>;
}

const passwordOf = (opts: SignupOptions) => opts.password ?? ('W2a!' + Math.random().toString(36).slice(2, 10) + '#7');

function baseAccount(host: string, label: string, email: string, pw: string, mail: Mailbox): AccountRecord {
  return {
    id: host + ':' + email,
    host,
    label,
    email,
    password: pw,
    mail_provider: mail.provider,
    status: 'needs_confirm',
    note: '',
    created_at: new Date().toISOString()
  };
}

export const aethyroAdapter: SiteAdapter = {
  host: 'aethyro.com',
  label: 'Aethyro (supabase, 200 credits, anon trial-chat)',
  async signup(mail, cfg, opts) {
    if (!cfg.supabase?.anon_key) return { ok: false, status: 'failed', message: 'supabase anon key not discovered, run: node src/cli.ts discover https://aethyro.com/' };
    const sbCfg = { url: cfg.supabase.url, anon_key: cfg.supabase.anon_key };
    const pw = passwordOf(opts);
    const box = mail.box ?? (await mail.create());
    const account = baseAccount(cfg.host, this.label, box.address, pw, box);

    const first = await sb.supabaseSignup(sbCfg, box.address, pw);
    account.note = 'signup ' + first.status + ' ' + truncate(first.message, 160);
    if (first.status >= 400) {
      if (first.status === 429) {
        account.status = 'failed';
        account.note = 'supabase email rate limit (shared SMTP), retry later or reuse an existing mailbox';
        return { ok: false, status: 'failed', message: account.note, account, mailbox: box };
      }
      account.status = 'failed';
      return { ok: false, status: 'failed', message: account.note, account, mailbox: box };
    }
    if (first.access_token) {
      account.access_token = first.access_token;
      account.refresh_token = first.refresh_token;
      account.user_id = first.user_id;
      account.status = 'active';
      return { ok: true, status: 'active', message: 'session issued without confirmation', account, mailbox: box };
    }
    if (opts.skipConfirm) return { ok: true, status: 'needs_confirm', message: 'account created, confirmation skipped', account, mailbox: box };

    const code = await mail.waitForCode({ timeoutMs: opts.confirmTimeoutMs ?? 150000 });
    if (code) {
      const verified = await sb.supabaseVerifyCode(sbCfg, box.address, code);
      if (verified.access_token) {
        account.access_token = verified.access_token;
        account.refresh_token = verified.refresh_token;
        account.user_id = verified.user_id;
        account.status = 'active';
        account.note = 'otp ' + code + ' verified';
        return { ok: true, status: 'active', message: 'verified via otp', account, mailbox: box };
      }
      account.note = 'otp found but verify failed: ' + truncate(verified.message, 140);
    }

    const link = await mail.waitForLink(/verify|confirm|token|auth\/v1/i, { timeoutMs: 30000 });
    if (link) {
      const res = await request(link, { maxRedirects: 6, timeoutMs: 25000 });
      account.note = 'link followed ' + res.status;
      if (res.status < 400) {
        const login = await sb.supabasePasswordGrant(sbCfg, box.address, pw);
        if (login.access_token) {
          account.access_token = login.access_token;
          account.refresh_token = login.refresh_token;
          account.user_id = login.user_id;
          account.status = 'active';
          return { ok: true, status: 'active', message: 'verified via link', account, mailbox: box };
        }
        account.note += ' | login: ' + truncate(login.message, 120);
      }
    }
    return { ok: true, status: 'needs_confirm', message: 'account pending confirmation: ' + account.note, account, mailbox: box };
  },
  async probeCredits(account, cfg) {
    if (!cfg.supabase?.anon_key) return { ok: false, detail: 'no supabase config' };
    const sbCfg = { url: cfg.supabase.url, anon_key: cfg.supabase.anon_key };
    if (!account.access_token) return { ok: false, detail: 'no access token' };
    const r = await sb.supabaseInvoke(sbCfg, 'chat', { message: 'hi', messages: [{ role: 'user', content: 'hi' }] }, account.access_token, { timeoutMs: 45000 });
    return { ok: r.status < 400, detail: 'chat fn -> ' + r.status + ' ' + truncate(r.text, 120) };
  }
};

export const trialProbe = async (cfg: SiteConfig, message = 'ping'): Promise<{ ok: boolean; status: number; text: string }> => {
  if (!cfg.supabase?.anon_key) return { ok: false, status: 0, text: 'no supabase config' };
  const sbCfg = { url: cfg.supabase.url, anon_key: cfg.supabase.anon_key };
  const r = await sb.supabaseInvoke(sbCfg, 'trial-chat', { message }, undefined, { timeoutMs: 60000 });
  return { ok: r.status === 200, status: r.status, text: r.text };
};

export const palvoroAdapter: SiteAdapter = {
  host: 'palvoro.com',
  label: 'Palvoro (supabase publishable key, 15000 signup bonus)',
  async signup(mail, cfg, opts) {
    if (!cfg.supabase?.anon_key) return { ok: false, status: 'failed', message: 'supabase config missing, run: node src/cli.ts discover https://www.palvoro.com/' };
    const sbCfg = { url: cfg.supabase.url, anon_key: cfg.supabase.anon_key };
    const pw = passwordOf(opts);
    const box = mail.box ?? (await mail.create());
    const account = baseAccount(cfg.host, this.label, box.address, pw, box);

    const attempts = 1 + (opts.retry429 ?? 0);
    let first = await sb.supabaseSignup(sbCfg, box.address, pw);
    for (let i = 1; i < attempts && first.status === 429; i++) {
      await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 60000));
      first = await sb.supabaseSignup(sbCfg, box.address, pw);
    }
    account.note = 'signup ' + first.status + ' ' + truncate(first.message, 160);

    if (first.status >= 400) {
      if (/not allowed/i.test(first.message)) {
        account.status = 'failed';
        account.note = 'P0001: this temp-mail domain is on palvoro blocklist (' + box.address.split('@')[1] + '). Use a domain that passes, e.g. create with --provider=tempmail.lol --domain=<allowed-domain>.';
      } else if (/please sign up at palvoro\.com/i.test(first.message)) {
        account.status = 'failed';
        account.note = 'P0001 guard: signup refused for this egress IP (one account per IP / abused). Rotate IP or reuse the account created from this IP.';
      } else if (first.status === 429) {
        account.status = 'failed';
        account.note = 'supabase email rate limit; retry later or increase --retry429';
      } else {
        account.status = 'failed';
      }
      return { ok: false, status: 'failed', message: account.note, account, mailbox: box };
    }

    let token = first.access_token;
    if (!token && !opts.skipConfirm) {
      const link = await mail.waitForLink(/auth\/v1\/verify/, { timeoutMs: opts.confirmTimeoutMs ?? 150000 });
      if (link) {
        const r = await request(link, { maxRedirects: 0, timeoutMs: 25000 });
        account.note += ' | link ' + r.status;
      }
      if (!token) {
        const code = await mail.waitForCode({ timeoutMs: 30000 });
        if (code) {
          const verified = await sb.supabaseVerifyCode(sbCfg, box.address, code);
          token = verified.access_token;
          account.note += ' | otp ' + (token ? 'ok' : 'failed');
        }
      }
      if (!token) {
        const login = await sb.supabasePasswordGrant(sbCfg, box.address, pw);
        token = login.access_token;
        account.refresh_token = login.refresh_token;
        account.user_id = login.user_id;
        account.note += ' | login ' + login.status;
      }
    }
    if (!token) return { ok: true, status: 'needs_confirm', message: 'pending confirmation: ' + account.note, account, mailbox: box };
    account.access_token = token;
    account.status = 'active';
    const bonus = await postJson<any>(cfg.origin + '/api/auth/grant-signup-bonus', {}, { headers: { apikey: sbCfg.anon_key, authorization: 'Bearer ' + token, 'content-type': 'application/json', origin: cfg.origin }, timeoutMs: 25000 });
    account.note += ' | bonus ' + bonus.status + ' ' + truncate(bonus.text, 120);
    return { ok: true, status: 'active', message: 'signup bonus: ' + truncate(bonus.text, 160), account, mailbox: box };
  },
  async probeCredits(account, cfg) {
    const out: string[] = [];
    for (const p of ['/api/settings/credits', '/api/users', '/api/user/credits']) {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (account.access_token) headers.authorization = 'Bearer ' + account.access_token;
      if (cfg.supabase?.anon_key) headers.apikey = cfg.supabase.anon_key;
      const r = await request(cfg.origin + p, { headers, timeoutMs: 20000 });
      out.push(p + ' -> ' + r.status + ' ' + truncate(r.text, 120));
      if (r.status === 200 && /credit|token|bonus/i.test(r.text)) return { ok: true, detail: out.join(' | ') };
    }
    return { ok: false, detail: out.join(' | ') };
  },
  async chatProbe(account, cfg) {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream', origin: cfg.origin };
    if (account.access_token) headers.authorization = 'Bearer ' + account.access_token;
    if (cfg.supabase?.anon_key) headers.apikey = cfg.supabase.anon_key;
    const r = await request(cfg.origin + '/api/chat', {
      method: 'POST', body: JSON.stringify({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'say PONG' }] }),
      headers, maxBytes: 80000, timeoutMs: 60000
    });
    return { ok: r.status === 200, detail: '/api/chat -> ' + r.status + ' ' + truncate(r.text, 160) };
  }
};

export const uhelpAdapter: SiteAdapter = {
  host: 'uhelp.ai',
  label: 'uhelp.ai (better-auth, 1000 credits)',
  async signup(mail, cfg, opts) {
    const pw = passwordOf(opts);
    const box = mail.box ?? (await mail.create());
    const account = baseAccount(cfg.host, this.label, box.address, pw, box);
    const jar = new CookieJar();
    const body = { email: box.address, password: pw, name: box.address.split('@')[0] };
    const r = await request(cfg.origin + '/api/auth/sign-up/email', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', accept: 'application/json', origin: cfg.origin, referer: cfg.origin + '/signup' },
      jar, timeoutMs: 25000
    });
    account.note = 'signup ' + r.status + ' ' + truncate(r.text, 160);
    account.cookies = jar.toJSON()[new URL(cfg.origin).host] ?? {};
    const session = await request(cfg.origin + '/api/auth/get-session', { headers: { accept: 'application/json' }, jar, timeoutMs: 20000 });
    if (session.status === 200 && /"user"/.test(session.text)) {
      account.status = 'active';
      account.note += ' | session ok';
      return { ok: true, status: 'active', message: 'session established', account, mailbox: box };
    }
    if (r.status >= 200 && r.status < 300) {
      const code = opts.skipConfirm ? undefined : await mail.waitForCode({ timeoutMs: opts.confirmTimeoutMs ?? 120000 });
      account.note += code ? ' | otp ' + code : ' | no otp mail';
      return { ok: true, status: code ? 'needs_confirm' : 'needs_confirm', message: 'signup accepted: ' + account.note, account, mailbox: box };
    }
    account.status = 'failed';
    return { ok: false, status: 'failed', message: account.note, account, mailbox: box };
  },
  async confirm(account, mail, cfg, opts) {
    const host = new URL(cfg.origin).host;
    const jar = CookieJar.fromJSON({ [host]: account.cookies ?? {} });
    const trace: string[] = [];

    const link = await mail.waitForLink(/auth\/(?:verify-email|email-otp)[^\s]*token=/, { timeoutMs: opts.confirmTimeoutMs ?? 90000 });
    if (link) {
      const normalized = (() => {
        try {
          const parsed = new URL(link);
          parsed.searchParams.delete('callbackURL');
          return parsed.toString();
        } catch { return link; }
      })();
      let r = await request(normalized, { jar, maxRedirects: 6, timeoutMs: 25000 });
      if (r.status >= 400) {
        try {
          const parsed = new URL(link);
          parsed.searchParams.set('callbackURL', cfg.origin + '/');
          r = await request(parsed.toString(), { jar, maxRedirects: 6, timeoutMs: 25000 });
        } catch {}
      }
      trace.push('link ' + r.status);
    }

    let code = await mail.waitForCode({ timeoutMs: link ? 20000 : (opts.confirmTimeoutMs ?? 90000) });
    if (code) {
      for (const a of [
        { url: cfg.origin + '/api/auth/email-otp/verify-email', body: { email: account.email, otp: code } },
        { url: cfg.origin + '/api/auth/verify-email', body: { email: account.email, otp: code } }
      ]) {
        const r = await request(a.url, { method: 'POST', body: JSON.stringify(a.body), headers: { 'content-type': 'application/json', accept: 'application/json', origin: cfg.origin }, jar, timeoutMs: 25000 });
        trace.push(a.url.split('/api/auth/')[1] + ' ' + r.status);
        if (r.status < 300) break;
      }
    }

    const login = await request(cfg.origin + '/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email: account.email, password: account.password }),
      headers: { 'content-type': 'application/json', accept: 'application/json', origin: cfg.origin },
      jar, timeoutMs: 25000
    });
    let body: any;
    try { body = JSON.parse(login.text); } catch { body = undefined; }
    account.cookies = jar.toJSON()[host] ?? {};
    trace.push('sign-in ' + login.status + (body?.user?.emailVerified ? ' verified' : ''));
    account.note = (account.note + ' | ' + trace.join(' | ')).trim();
    if (login.status < 300 && (body?.token || body?.user?.email)) {
      account.status = 'active';
      account.access_token = body?.token ?? account.access_token;
      return { ok: true, status: 'active', message: 'verified + signed in (' + trace.join(', ') + ')', account };
    }
    return { ok: false, status: 'needs_confirm', message: 'confirm incomplete: ' + trace.join(', '), account };
  },
  async probeCredits(account, cfg) {
    const jar = CookieJar.fromJSON({ [new URL(cfg.origin).host]: account.cookies ?? {} });
    for (const p of ['/api/auth/get-session', '/api/credits', '/api/usage', '/api/me']) {
      const r = await request(cfg.origin + p, { headers: { accept: 'application/json' }, jar, timeoutMs: 15000 });
      if (r.status === 200) return { ok: true, detail: p + ' -> ' + truncate(r.text, 140) };
    }
    return { ok: false, detail: 'no credit endpoint responded 200' };
  }
};

export const superappAdapter: SiteAdapter = {
  host: 'superapp.chat',
  label: 'SuperApp (auth0, 5000 quota)',
  async signup(mail, cfg, opts) {
    if (!cfg.auth0?.client_id) return { ok: false, status: 'failed', message: 'auth0 client id not discovered, run: node src/cli.ts discover https://superapp.chat/' };
    const pw = passwordOf(opts);
    const box = mail.box ?? (await mail.create());
    const account = baseAccount(cfg.host, this.label, box.address, pw, box);
    const r = await postJson<any>('https://' + cfg.auth0.domain + '/dbconnections/signup', {
      client_id: cfg.auth0.client_id,
      email: box.address,
      password: pw,
      connection: 'Username-Password-Authentication'
    }, { timeoutMs: 25000 });
    account.note = 'signup ' + r.status + ' ' + truncate(r.text, 180);
    if (r.status >= 400) {
      account.status = 'failed';
      return { ok: false, status: 'failed', message: account.note, account, mailbox: box };
    }
    account.user_id = r.data?._id;
    account.status = 'needs_confirm';
    if (!opts.skipConfirm) {
      const code = await mail.waitForCode({ timeoutMs: opts.confirmTimeoutMs ?? 150000 });
      if (code) {
        const verify = await postJson<any>('https://' + cfg.auth0.domain + '/dbconnections/verify_email', { client_id: cfg.auth0.client_id, connection: 'Username-Password-Authentication', code, email: box.address }, { timeoutMs: 25000 });
        account.note += ' | verify ' + verify.status;
      }
    }
    const token = await postJson<any>('https://' + cfg.auth0.domain + '/oauth/token', {
      grant_type: 'password',
      username: box.address,
      password: pw,
      client_id: cfg.auth0.client_id,
      audience: cfg.auth0.audience,
      scope: 'openid profile email offline_access'
    }, { timeoutMs: 25000 });
    if (token.status < 300 && token.data?.access_token) {
      account.access_token = token.data.access_token;
      account.refresh_token = token.data.refresh_token;
      account.status = 'active';
      return { ok: true, status: 'active', message: 'auth0 token issued', account, mailbox: box };
    }
    account.note += ' | token ' + token.status + ' ' + truncate(token.text, 160);
    if (/unauthorized_client|not allowed for the client/i.test(token.text)) {
      account.note += ' | this Auth0 client disables password / password-realm grants: tokens can only be minted through the browser PKCE authorization-code flow (Universal Login), so a headless signup cannot reach /api/v1/*.';
    }
    return { ok: true, status: 'needs_confirm', message: 'pending email verification: ' + account.note, account, mailbox: box };
  },
  async probeCredits(account, cfg) {
    if (!account.access_token) return { ok: false, detail: 'no auth0 token' };
    const r = await request(cfg.origin + '/api/v1/models', { headers: { authorization: 'Bearer ' + account.access_token, accept: 'application/json' }, timeoutMs: 20000 });
    return { ok: r.status === 200, detail: 'models -> ' + r.status + ' ' + truncate(r.text, 160) };
  }
};

export const ADAPTERS: SiteAdapter[] = [aethyroAdapter, palvoroAdapter, uhelpAdapter, superappAdapter];

export function adapterFor(host: string): SiteAdapter | undefined {
  return ADAPTERS.find((a) => host.includes(a.host) || a.host.includes(host.replace(/^www\./, '')));
}
