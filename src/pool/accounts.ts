import { readJson, writeJson } from '../core/store.ts';
import type { AccountRecord } from '../hunt/sites.ts';

export interface AccountState {
  id: string;
  host: string;
  state: 'ready' | 'cooling' | 'dead';
  remaining: number | null;
  last_status: number;
  last_error?: string;
  cooldown_until: number;
  wins: number;
  losses: number;
  strikes: number;
  last_used: number;
  used: number;
}

const COOLDOWN_MS = 30 * 60 * 1000;
const QUOTA_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const AUTH_STRIKES = 2;

export class AccountPool {
  private states = new Map<string, AccountState>();
  private accounts: AccountRecord[] = [];
  private file: string;
  private accountsFile: string;

  constructor(opts: { accountsFile?: string; stateFile?: string } = {}) {
    this.accountsFile = opts.accountsFile ?? 'data/accounts.json';
    this.file = opts.stateFile ?? 'data/state/accounts-pool.json';
  }

  async load(): Promise<void> {
    this.accounts = (await readJson<AccountRecord[]>(this.accountsFile)) ?? [];
    const stored = (await readJson<AccountState[]>(this.file)) ?? [];
    for (const s of stored) this.states.set(s.id, s);
    for (const acc of this.accounts) if (!this.states.has(acc.id)) this.states.set(acc.id, this.fresh(acc));
  }

  refreshAccounts(): Promise<void> {
    return this.load();
  }

  private fresh(acc: AccountRecord): AccountState {
    return {
      id: acc.id,
      host: acc.host,
      state: 'ready',
      remaining: null,
      last_status: 0,
      cooldown_until: 0,
      wins: 0,
      losses: 0,
      strikes: 0,
      last_used: 0,
      used: 0
    };
  }

  state(id: string): AccountState | undefined {
    return this.states.get(id);
  }

  private usable(acc: AccountRecord, now: number): boolean {
    if (acc.status !== 'active') return false;
    const s = this.states.get(acc.id);
    if (!s) return true;
    if (s.state === 'dead') return false;
    if (s.state === 'cooling' && s.cooldown_until > now) return false;
    if (typeof s.remaining === 'number' && s.remaining <= 0 && s.cooldown_until > now) return false;
    return true;
  }

  private score(s: AccountState | undefined, acc: AccountRecord): number {
    if (!s) return 1000;
    const remaining = typeof s.remaining === 'number' ? s.remaining : 500;
    const fresh = s.last_used === 0 ? 300 : 0;
    const winRate = (s.wins - s.losses * 2) * 20;
    return remaining + fresh + winRate - s.used * 3;
  }

  candidates(hostMatcher: string): AccountRecord[] {
    const now = Date.now();
    const matcher = hostMatcher.toLowerCase();
    return this.accounts
      .filter((a) => a.host.toLowerCase().includes(matcher) && this.usable(a, now))
      .sort((a, b) => this.score(this.states.get(b.id), b) - this.score(this.states.get(a.id), a));
  }

  pick(hostMatcher: string, exclude: Set<string> = new Set(), limit = 3): AccountRecord[] {
    return this.candidates(hostMatcher).filter((a) => !exclude.has(a.id)).slice(0, limit);
  }

  report(id: string, outcome: { ok: boolean; status: number; remaining?: number | null; error?: string }): AccountState {
    const acc = this.accounts.find((a) => a.id === id);
    const state = this.states.get(id) ?? (acc ? this.fresh(acc) : { id, host: '', state: 'ready' as const, remaining: null, last_status: 0, cooldown_until: 0, wins: 0, losses: 0, strikes: 0, last_used: 0, used: 0 });
    state.used += 1;
    state.last_used = Date.now();
    state.last_status = outcome.status;
    if (outcome.ok) {
      state.wins += 1;
      state.strikes = 0;
      state.state = 'ready';
      state.last_error = undefined;
      state.cooldown_until = 0;
      if (typeof outcome.remaining === 'number') state.remaining = outcome.remaining;
    } else {
      state.losses += 1;
      state.last_error = outcome.error;
      if (outcome.status === 402 || (outcome.status === 429 && outcome.error !== undefined && /quota|insufficient|balance|credit/i.test(outcome.error ?? ''))) {
        state.remaining = 0;
        state.state = 'cooling';
        state.cooldown_until = Date.now() + QUOTA_COOLDOWN_MS;
      } else if (outcome.status === 401 || outcome.status === 403) {
        state.strikes += 1;
        state.state = state.strikes >= AUTH_STRIKES ? 'dead' : 'cooling';
        state.cooldown_until = Date.now() + COOLDOWN_MS;
      } else if (outcome.status === 429) {
        state.state = 'cooling';
        state.cooldown_until = Date.now() + COOLDOWN_MS;
      }
    }
    this.states.set(id, state);
    return state;
  }

  summary(hostMatcher?: string): AccountState[] {
    const all = [...this.states.values()];
    if (!hostMatcher) return all;
    const m = hostMatcher.toLowerCase();
    return all.filter((s) => s.host.toLowerCase().includes(m));
  }

  async save(): Promise<void> {
    await writeJson(this.file, this.summary());
  }
}
