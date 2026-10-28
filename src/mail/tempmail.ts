import { getJson, request, postJson } from '../core/http.ts';
import { sleep, truncate } from '../core/util.ts';
import { ImapClient, parseMime } from './imap.ts';
import type { ImapOptions } from './imap.ts';

export interface MailMessage {
  id: string;
  from: string;
  subject: string;
  intro: string;
  text: string;
  html: string[];
  createdAt: string;
}

export interface Mailbox {
  provider: string;
  address: string;
  password: string;
  id: string;
  token: string;
  createdAt: string;
}

export const PROVIDERS = [
  { name: 'mail.tm', kind: 'rest', base: 'https://api.mail.tm' },
  { name: 'mail.gw', kind: 'rest', base: 'https://api.mail.gw' },
  { name: 'tempmail.lol', kind: 'lol', base: 'https://api.tempmail.lol' },
  { name: 'guerrilla', kind: 'guerrilla', base: 'https://api.guerrillamail.com' },
  { name: 'imap', kind: 'imap', base: '' }
];

const stripHtml = (s: string) => s
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&#x2F;/g, '/')
  .replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ')
  .trim();

export function extractCodes(text: string): string[] {
  const digits: string[] = [];
  const loose: string[] = [];
  for (const m of text.matchAll(/\b(\d{6})\b/g)) digits.push(m[1]);
  for (const m of text.matchAll(/(?:code|otp|verif[a-z]*|passcode)[^A-Za-z0-9]{0,8}([A-Za-z0-9]{4,8})/gi)) {
    const v = m[1].toUpperCase();
    if (/^\d{4,8}$/.test(v) || (/^[A-Z0-9]{4,8}$/.test(v) && /\d/.test(v))) loose.push(v);
  }
  for (const m of text.matchAll(/\b(?=[A-Z0-9]{6}\b)(?=[A-Z0-9]*\d)[A-Z0-9]{6}\b/g)) loose.push(m[0]);
  return [...new Set([...digits, ...loose])].slice(0, 6);
}

export function extractLinks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>)]+/g)) out.push(m[0].replace(/[.,;:]+$/, ''));
  return [...new Set(out)].slice(0, 25);
}

export class TempMail {
  base: string;
  provider: string;
  kind: string;
  preferredDomain?: string;
  imap?: ImapOptions;
  box?: Mailbox;

  constructor(providerName?: string, preferredDomain?: string, imap?: ImapOptions) {
    const hit = PROVIDERS.find((p) => p.name === providerName) ?? PROVIDERS[0];
    this.provider = hit.name;
    this.base = hit.base;
    this.kind = hit.kind;
    this.preferredDomain = preferredDomain;
    this.imap = imap ?? (hit.kind === 'imap' ? {
      host: process.env.W2A_IMAP_HOST ?? '',
      port: Number(process.env.W2A_IMAP_PORT ?? 993),
      user: process.env.W2A_IMAP_USER ?? '',
      pass: process.env.W2A_IMAP_PASS ?? '',
      secure: process.env.W2A_IMAP_SECURE !== 'false'
    } : undefined);
  }

  private imapClient(): ImapClient {
    if (!this.imap?.host || !this.imap.user) throw new Error('imap not configured: set W2A_IMAP_HOST / W2A_IMAP_USER / W2A_IMAP_PASS / W2A_IMAP_DOMAIN');
    return new ImapClient(this.imap);
  }

  async domains(): Promise<string[]> {
    if (this.kind === 'rest') {
      const data = await getJson<any>(this.base + '/domains?page=1');
      const list = Array.isArray(data) ? data : data?.['hydra:member'] ?? [];
      return list.filter((d: any) => d.isActive !== false).map((d: any) => d.domain as string);
    }
    if (this.kind === 'lol') {
      const data = await getJson<any>(this.base + '/v2/domains');
      const list = Array.isArray(data) ? data : data?.domains ?? [];
      return list.map((d: any) => (typeof d === 'string' ? d : d.domain)).filter(Boolean);
    }
    return ['guerrillamailblock.com'];
  }

  async create(localPart?: string, password?: string): Promise<Mailbox> {
    if (this.kind === 'imap') {
      const domain = this.preferredDomain ?? process.env.W2A_IMAP_DOMAIN ?? '';
      if (!domain) throw new Error('imap catch-all domain missing: set W2A_IMAP_DOMAIN (e.g. mydomain.com)');
      const local = localPart ?? 'w2a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      this.box = {
        provider: this.provider,
        address: local + '@' + domain,
        password: '',
        id: '',
        token: 'imap',
        createdAt: new Date().toISOString()
      };
      return this.box;
    }
    if (this.kind === 'lol') {
      const payload: Record<string, string> = {};
      if (localPart) payload.prefix = localPart;
      if (this.preferredDomain) payload.domain = this.preferredDomain;
      const r = await postJson<any>(this.base + '/v2/inbox/create', payload, { timeoutMs: 25000 });
      if (r.status >= 300 || !r.data?.address) throw new Error('tempmail.lol create failed: ' + r.status + ' ' + truncate(r.text, 160));
      this.box = {
        provider: this.provider,
        address: String(r.data.address),
        password: '',
        id: '',
        token: String(r.data.token ?? ''),
        createdAt: new Date().toISOString()
      };
      return this.box;
    }
    if (this.kind === 'guerrilla') {
      const r = await getJson<any>(this.base + '/ajax.php?f=get_email_address&lang=en');
      if (!r?.email_addr) throw new Error('guerrilla create failed');
      this.box = {
        provider: this.provider,
        address: String(r.email_addr),
        password: '',
        id: String(r.sid_token ?? ''),
        token: String(r.sid_token ?? ''),
        createdAt: new Date().toISOString()
      };
      return this.box;
    }
    const domains = await this.domains();
    if (domains.length === 0) throw new Error('no active temp-mail domain on ' + this.provider);
    const local = localPart ?? 'w2a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const address = local + '@' + domains[0];
    const pw = password ?? ('Px' + Math.random().toString(36).slice(2, 10) + '!9a');
    const created = await postJson<any>(this.base + '/accounts', { address, password: pw });
    if (created.status >= 300) throw new Error('temp-mail account failed: ' + created.status + ' ' + truncate(created.text, 200));
    const tok = await postJson<any>(this.base + '/token', { address, password: pw });
    if (tok.status >= 300 || !tok.data?.token) throw new Error('temp-mail token failed: ' + tok.status + ' ' + truncate(tok.text, 200));
    this.box = {
      provider: this.provider,
      address,
      password: pw,
      id: String(created.data?.id ?? ''),
      token: String(tok.data.token),
      createdAt: new Date().toISOString()
    };
    return this.box;
  }

  async adopt(box: Mailbox): Promise<Mailbox> {
    this.box = box;
    if (this.kind === 'rest') {
      const tok = await postJson<any>(this.base + '/token', { address: box.address, password: box.password });
      if (tok.status < 300 && tok.data?.token) this.box = { ...box, token: String(tok.data.token) };
    }
    return this.box;
  }

  private auth() {
    if (!this.box) throw new Error('mailbox not initialised');
    return { authorization: 'Bearer ' + this.box.token, accept: 'application/json' };
  }

  async list(): Promise<{ id: string; from: string; subject: string; intro: string; createdAt: string }[]> {
    if (!this.box) throw new Error('mailbox not initialised');
    if (this.kind === 'imap') {
      const client = this.imapClient();
      await client.connect();
      await client.login();
      await client.select(this.imap?.mailbox ?? 'INBOX');
      const uids = await client.search('UNSEEN');
      const out: { id: string; from: string; subject: string; intro: string; createdAt: string }[] = [];
      for (const uid of uids.slice(-15)) {
        const raw = await client.fetchBody(uid);
        const parsed = parseMime(raw);
        if (!parsed.subject && !parsed.text) continue;
        out.push({ id: uid, from: parsed.from, subject: parsed.subject, intro: parsed.text.slice(0, 120), createdAt: '' });
      }
      await client.logout();
      return out;
    }
    if (this.kind === 'lol') {
      const data = await getJson<any>(this.base + '/v2/inbox?token=' + encodeURIComponent(this.box.token), { timeoutMs: 20000 });
      const list = Array.isArray(data?.emails) ? data.emails : [];
      return list.map((m: any, i: number) => ({
        id: String(m.id ?? m.date ?? i) + ':' + i,
        from: String(m.from ?? ''),
        subject: String(m.subject ?? ''),
        intro: String(m.body ?? '').slice(0, 120),
        createdAt: String(m.date ?? '')
      }));
    }
    if (this.kind === 'guerrilla') {
      const data = await getJson<any>(this.base + '/ajax.php?f=get_email_list&offset=0&sid_token=' + encodeURIComponent(this.box.token), { timeoutMs: 20000 });
      const list = Array.isArray(data?.list) ? data.list : [];
      return list.map((m: any) => ({
        id: String(m.mail_id),
        from: String(m.mail_from ?? ''),
        subject: String(m.mail_subject ?? ''),
        intro: String(m.mail_excerpt ?? ''),
        createdAt: String(m.mail_timestamp ?? '')
      }));
    }
    const data = await getJson<any>(this.base + '/messages?page=1', { headers: this.auth(), timeoutMs: 20000 });
    const list = Array.isArray(data) ? data : data?.['hydra:member'] ?? [];
    return list.map((m: any) => ({
      id: String(m.id),
      from: m.from?.address ?? '',
      subject: m.subject ?? '',
      intro: m.intro ?? '',
      createdAt: m.createdAt ?? ''
    }));
  }

  async read(id: string): Promise<MailMessage> {
    if (!this.box) throw new Error('mailbox not initialised');
    if (this.kind === 'imap') {
      const client = this.imapClient();
      await client.connect();
      await client.login();
      await client.select(this.imap?.mailbox ?? 'INBOX');
      const raw = await client.fetchBody(id);
      await client.logout();
      const parsed = parseMime(raw);
      return { id, from: parsed.from, subject: parsed.subject, intro: parsed.text.slice(0, 120), text: parsed.text, html: parsed.html, createdAt: '' };
    }
    if (this.kind === 'lol') {
      const data = await getJson<any>(this.base + '/v2/inbox?token=' + encodeURIComponent(this.box.token), { timeoutMs: 20000 });
      const list = Array.isArray(data?.emails) ? data.emails : [];
      const idx = Number(id.split(':')[1] ?? 0);
      const m = list[idx] ?? {};
      const html = typeof m.html === 'string' ? [m.html] : Array.isArray(m.html) ? m.html : [];
      const text = [String(m.body ?? ''), ...html.map((h: string) => stripHtml(h))].filter(Boolean).join('\n');
      return { id, from: String(m.from ?? ''), subject: String(m.subject ?? ''), intro: text.slice(0, 120), text, html, createdAt: String(m.date ?? '') };
    }
    if (this.kind === 'guerrilla') {
      const data = await getJson<any>(this.base + '/ajax.php?f=fetch_email&email_id=' + encodeURIComponent(id) + '&sid_token=' + encodeURIComponent(this.box.token), { timeoutMs: 20000 });
      const html = typeof data?.mail_body === 'string' ? [data.mail_body] : [];
      const text = [stripHtml(String(data?.mail_body ?? ''))].filter(Boolean).join('\n');
      return { id, from: String(data?.mail_from ?? ''), subject: String(data?.mail_subject ?? ''), intro: text.slice(0, 120), text, html, createdAt: String(data?.mail_timestamp ?? '') };
    }
    const m = await getJson<any>(this.base + '/messages/' + id, { headers: this.auth() });
    const html: string[] = Array.isArray(m?.html) ? m.html : m?.html ? [String(m.html)] : [];
    const textParts = [String(m?.text ?? ''), ...html.map((h) => stripHtml(h))].filter(Boolean);
    return {
      id,
      from: m?.from?.address ?? '',
      subject: m?.subject ?? '',
      intro: m?.intro ?? '',
      text: textParts.join('\n').trim(),
      html,
      createdAt: m?.createdAt ?? ''
    };
  }

  async waitFor<T>(fn: (m: MailMessage) => T | undefined, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<T | undefined> {
    const deadline = Date.now() + (opts.timeoutMs ?? 120000);
    const interval = opts.intervalMs ?? 4000;
    const seen = new Set<string>();
    while (Date.now() < deadline) {
      let list: { id: string }[] = [];
      try { list = await this.list(); } catch { list = []; }
      for (const item of list) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        const msg = await this.read(item.id);
        const hit = fn(msg);
        if (hit !== undefined) return hit;
      }
      await sleep(interval);
    }
    return undefined;
  }

  async waitForCode(opts: { timeoutMs?: number } = {}): Promise<string | undefined> {
    return this.waitFor((m) => {
      const blob = m.subject + ' ' + m.text;
      if (!/verif|code|confirm|sign\s*in|password|magic|login/i.test(blob)) return undefined;
      const codes = extractCodes(blob);
      return codes[0];
    }, opts);
  }

  async waitForLink(re: RegExp, opts: { timeoutMs?: number } = {}): Promise<string | undefined> {
    return this.waitFor((m) => {
      const links = [...extractLinks(m.text), ...extractLinks(m.html.join(' '))];
      return links.find((l) => re.test(l));
    }, opts);
  }
}
