import { ensureSiteConfig } from './discover.ts';
import type { SiteConfig } from './discover.ts';
import { TempMail } from '../mail/tempmail.ts';
import type { Mailbox } from '../mail/tempmail.ts';
import { adapterFor, ADAPTERS } from './sites.ts';
import type { AccountRecord, SignupOutcome } from './sites.ts';
import { readJson, writeJson } from '../core/store.ts';

export interface HuntResult {
  ok: boolean;
  host: string;
  label: string;
  message: string;
  account?: AccountRecord;
  mailbox?: Mailbox;
  config: SiteConfig;
}

async function loadAccounts(): Promise<AccountRecord[]> {
  return (await readJson<AccountRecord[]>('data/accounts.json')) ?? [];
}

async function saveAccount(account: AccountRecord): Promise<void> {
  const list = await loadAccounts();
  const idx = list.findIndex((a) => a.id === account.id);
  if (idx >= 0) list[idx] = { ...list[idx], ...account };
  else list.push(account);
  await writeJson('data/accounts.json', list);
}

export async function hunt(hostOrUrl: string, opts: { provider?: string; domain?: string; password?: string; confirmTimeoutMs?: number; skipConfirm?: boolean; refreshConfig?: boolean; retry429?: number; retryDelayMs?: number } = {}): Promise<HuntResult> {
  const cfg = await ensureSiteConfig(hostOrUrl, { refresh: opts.refreshConfig });
  const adapter = adapterFor(cfg.host);
  if (!adapter) {
    return { ok: false, host: cfg.host, label: 'unknown', message: 'no adapter for ' + cfg.host + ' (known: ' + ADAPTERS.map((a) => a.host).join(', ') + ')', config: cfg };
  }
  const mail = new TempMail(opts.provider, opts.domain);
  let mailbox: Mailbox | undefined;
  try {
    mailbox = await mail.create();
  } catch (e: any) {
    return { ok: false, host: cfg.host, label: adapter.label, message: 'temp mailbox failed: ' + String(e?.message ?? e), config: cfg };
  }
  await writeJson('data/state/last-mailbox.json', mailbox);
  const outcome: SignupOutcome = await adapter.signup(mail, cfg, {
    password: opts.password,
    confirmTimeoutMs: opts.confirmTimeoutMs,
    skipConfirm: opts.skipConfirm,
    retry429: opts.retry429,
    retryDelayMs: opts.retryDelayMs
  });
  if (outcome.account) await saveAccount(outcome.account);
  return {
    ok: outcome.ok,
    host: cfg.host,
    label: adapter.label,
    message: outcome.message,
    account: outcome.account,
    mailbox: mailbox,
    config: cfg
  };
}

export async function confirmAccount(hostOrUrl: string, email: string, opts: { confirmTimeoutMs?: number; skipConfirm?: boolean } = {}): Promise<HuntResult> {
  const cfg = await ensureSiteConfig(hostOrUrl);
  const adapter = adapterFor(cfg.host);
  if (!adapter) return { ok: false, host: cfg.host, label: 'unknown', message: 'no adapter for ' + cfg.host, config: cfg };
  if (!adapter.confirm) return { ok: false, host: cfg.host, label: adapter.label, message: 'adapter has no confirm step', config: cfg };
  const list = await loadAccounts();
  const account = list.find((a) => a.email === email);
  if (!account) return { ok: false, host: cfg.host, label: adapter.label, message: 'no stored account for ' + email, config: cfg };
  const box = await readJson<Mailbox>('data/state/last-mailbox.json');
  if (!box) return { ok: false, host: cfg.host, label: adapter.label, message: 'no stored mailbox', config: cfg };
  const mail = new TempMail(box.provider);
  await mail.adopt(box);
  const outcome = await adapter.confirm(account, mail, cfg, { confirmTimeoutMs: opts.confirmTimeoutMs });
  if (outcome.account) await saveAccount(outcome.account);
  return { ok: outcome.ok, host: cfg.host, label: adapter.label, message: outcome.message, account: outcome.account, mailbox: box, config: cfg };
}

export async function probeAccountChat(hostOrUrl: string, email?: string): Promise<string> {
  const cfg = await ensureSiteConfig(hostOrUrl);
  const adapter = adapterFor(cfg.host);
  if (!adapter) return 'no adapter for ' + cfg.host;
  if (!adapter.chatProbe) return adapter.label + ': adapter has no chatProbe';
  const list = await loadAccounts();
  const account = email ? list.find((a) => a.email === email) : list.filter((a) => a.host === cfg.host).at(-1);
  if (!account) return 'no stored account for ' + cfg.host;
  const res = await adapter.chatProbe(account, cfg);
  return account.email + ' -> ' + (res.ok ? 'OK ' : 'FAIL ') + res.detail;
}

export async function probeAccountCredits(hostOrUrl: string, email?: string): Promise<string> {
  const cfg = await ensureSiteConfig(hostOrUrl);
  const adapter = adapterFor(cfg.host);
  if (!adapter) return 'no adapter for ' + cfg.host;
  const list = await loadAccounts();
  const account = email ? list.find((a) => a.email === email) : list.filter((a) => a.host === cfg.host).at(-1);
  if (!account) return 'no stored account for ' + cfg.host;
  const r = await adapter.probeCredits(account, cfg);
  return account.email + ' -> ' + (r.ok ? 'OK ' : 'FAIL ') + r.detail;
}
