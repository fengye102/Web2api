export class TokenBucket {
  private capacity: number;
  private tokens: number;
  private refillPerMs: number;
  private updated = Date.now();

  constructor(perMinute: number) {
    this.capacity = Math.max(1, perMinute);
    this.tokens = this.capacity;
    this.refillPerMs = this.capacity / 60000;
  }

  take(n = 1): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.updated) * this.refillPerMs);
    this.updated = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }

  snapshot(): { capacity: number; tokens: number } {
    return { capacity: this.capacity, tokens: Math.floor(this.tokens) };
  }
}

export class ConcurrencyGate {
  private active = 0;
  private queue: (() => void)[] = [];
  private limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
    return () => this.release();
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) next();
  }

  snapshot(): { active: number; queued: number; limit: number } {
    return { active: this.active, queued: this.queue.length, limit: this.limit };
  }
}

export class RateLimiter {
  private buckets = new Map<string, TokenBucket>();
  private global: TokenBucket;
  private perMinute: number;

  constructor(perMinute: number) {
    this.perMinute = perMinute;
    this.global = new TokenBucket(perMinute * 4);
  }

  check(key: string): { ok: boolean; retryAfterMs: number } {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(this.perMinute);
      this.buckets.set(key, bucket);
    }
    if (!this.global.take(1)) return { ok: false, retryAfterMs: 1000 };
    if (!bucket.take(1)) return { ok: false, retryAfterMs: Math.ceil(60000 / this.perMinute) };
    return { ok: true, retryAfterMs: 0 };
  }

  snapshot(): { keys: number; global: { capacity: number; tokens: number } } {
    return { keys: this.buckets.size, global: this.global.snapshot() };
  }
}
