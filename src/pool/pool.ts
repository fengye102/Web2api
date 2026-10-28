import { readJson, writeJson } from '../core/store.ts';

export interface PoolEntry {
  upstream: string;
  state: 'ready' | 'cooling' | 'dead';
  remaining: number | null;
  last_status: number;
  last_error?: string;
  cooldown_until: number;
  used: number;
  wins: number;
  losses: number;
}

export class UpstreamPool {
  private entries = new Map<string, PoolEntry>();
  private file = 'data/state/pool.json';

  async load(): Promise<void> {
    const stored = await readJson<PoolEntry[]>(this.file);
    if (!stored) return;
    for (const e of stored) this.entries.set(e.upstream, e);
  }

  get(id: string): PoolEntry {
    let e = this.entries.get(id);
    if (!e) {
      e = { upstream: id, state: 'ready', remaining: null, last_status: 0, cooldown_until: 0, used: 0, wins: 0, losses: 0 };
      this.entries.set(id, e);
    }
    return e;
  }

  order(ids: string[]): string[] {
    const now = Date.now();
    return [...ids].sort((a, b) => {
      const ea = this.get(a);
      const eb = this.get(b);
      const rank = (e: PoolEntry) => (e.state === 'dead' ? 2 : e.state === 'cooling' && e.cooldown_until > now ? 1 : 0);
      const ra = rank(ea);
      const rb = rank(eb);
      if (ra !== rb) return ra - rb;
      const sa = ea.wins - ea.losses;
      const sb = eb.wins - eb.losses;
      if (sa !== sb) return sb - sa;
      return ea.used - eb.used;
    });
  }

  record(id: string, outcome: { ok: boolean; status: number; remaining?: number | null; error?: string; cooldownMs?: number }): PoolEntry {
    const e = this.get(id);
    e.used += 1;
    e.last_status = outcome.status;
    if (outcome.ok) {
      e.wins += 1;
      e.state = 'ready';
      e.last_error = undefined;
      if (typeof outcome.remaining === 'number') e.remaining = outcome.remaining;
    } else {
      e.losses += 1;
      e.last_error = outcome.error;
      if (outcome.status === 429) {
        e.state = 'cooling';
        e.cooldown_until = Date.now() + (outcome.cooldownMs ?? 6 * 3600_000);
        e.remaining = 0;
      } else if (outcome.status === 401 || outcome.status === 403) {
        e.state = 'dead';
      }
    }
    return e;
  }

  snapshot(): PoolEntry[] {
    return [...this.entries.values()];
  }

  async save(): Promise<void> {
    await writeJson(this.file, this.snapshot());
  }
}
