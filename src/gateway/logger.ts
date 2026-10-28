import { appendLine } from '../core/store.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

export class Logger {
  private ring: LogEntry[] = [];
  private level: LogLevel;
  private file?: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(opts: { level?: LogLevel; file?: string; ringSize?: number } = {}) {
    this.level = opts.level ?? 'info';
    this.file = opts.file;
    this.ringSize = opts.ringSize ?? 400;
  }

  private ringSize: number;

  setLevel(level: LogLevel): void { this.level = level; }

  private write(level: LogLevel, msg: string, extra: Record<string, unknown> = {}): void {
    if (ORDER[level] < ORDER[this.level]) return;
    const entry: LogEntry = { ts: new Date().toISOString(), level, msg, ...extra };
    this.ring.push(entry);
    if (this.ring.length > this.ringSize) this.ring.shift();
    const line = JSON.stringify(entry);
    if (level === 'error') console.error(line);
    else console.log(line);
    if (this.file) {
      const target = this.file;
      this.pending = this.pending.then(() => appendLine(target, line)).catch(() => {});
    }
  }

  debug(msg: string, extra?: Record<string, unknown>): void { this.write('debug', msg, extra); }
  info(msg: string, extra?: Record<string, unknown>): void { this.write('info', msg, extra); }
  warn(msg: string, extra?: Record<string, unknown>): void { this.write('warn', msg, extra); }
  error(msg: string, extra?: Record<string, unknown>): void { this.write('error', msg, extra); }

  tail(limit = 50): LogEntry[] {
    return this.ring.slice(-limit);
  }
}
