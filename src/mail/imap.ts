import net from 'node:net';
import tls from 'node:tls';

export interface ImapOptions {
  host: string;
  port?: number;
  user: string;
  pass: string;
  mailbox?: string;
  secure?: boolean;
  timeoutMs?: number;
}

interface Line {
  tag: string;
  text: string;
}

export class ImapClient {
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private waiters: ((chunk: Buffer) => void)[] = [];
  private seq = 0;
  private opts: ImapOptions;

  constructor(opts: ImapOptions) {
    this.opts = opts;
  }

  private tag(): string {
    this.seq += 1;
    return 'A' + String(this.seq).padStart(3, '0');
  }

  async connect(): Promise<string> {
    const opts = this.opts;
    const port = opts.port ?? (opts.secure === false ? 143 : 993);
    await new Promise<void>((resolve, reject) => {
      const onError = (e: Error) => { reject(e); };
      const sock = opts.secure === false
        ? net.connect({ host: opts.host, port }, () => resolve())
        : tls.connect({ host: opts.host, port, servername: opts.host }, () => resolve());
      sock.once('error', onError);
      sock.once('timeout', () => reject(new Error('imap connect timeout')));
      sock.setTimeout(opts.timeoutMs ?? 20000);
      sock.on('data', (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const waiters = this.waiters;
        this.waiters = [];
        for (const fn of waiters) fn(this.buffer);
      });
      this.socket = sock;
    });
    const greeting = await this.readUntil(/^\* (OK|PREAUTH)/m);
    return greeting;
  }

  private write(line: string): void {
    if (!this.socket) throw new Error('imap not connected');
    this.socket.write(line + '\r\n');
  }

  private async readUntil(pattern: RegExp, timeoutMs = 30000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (pattern.test(this.buffer.toString('utf8'))) return this.buffer.toString('utf8');
      if (Date.now() > deadline) throw new Error('imap read timeout');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('imap read timeout')), Math.max(200, deadline - Date.now()));
        this.waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
  }

  private take(n: number): Buffer {
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return out;
  }

  async command(cmd: string, timeoutMs = 30000): Promise<Line> {
    const tag = this.tag();
    this.buffer = Buffer.alloc(0);
    this.write(tag + ' ' + cmd);
    const done = new RegExp('^' + tag + ' (OK|NO|BAD)', 'm');
    const text = await this.readUntil(done, timeoutMs);
    const end = text.search(done);
    const tail = text.slice(end).split('\r\n')[0];
    const chunk = this.take(end + tail.length + 2);
    const body = chunk.toString('utf8');
    return { tag, text: body };
  }

  async login(): Promise<void> {
    const r = await this.command('LOGIN "' + this.opts.user.replace(/"/g, '\\"') + '" "' + this.opts.pass.replace(/"/g, '\\"') + '"');
    if (!/ OK/i.test(r.text.split('\r\n').filter(Boolean).at(-1) ?? '')) throw new Error('imap login failed: ' + r.text.slice(-200));
  }

  async select(mailbox = 'INBOX'): Promise<string> {
    const r = await this.command('SELECT "' + mailbox + '"');
    if (/ NO | BAD /i.test(r.text)) throw new Error('imap select failed: ' + r.text.slice(-200));
    return r.text;
  }

  async search(criteria = 'UNSEEN'): Promise<string[]> {
    const r = await this.command('UID SEARCH ' + criteria);
    const line = r.text.split('\r\n').find((l) => /^\* SEARCH/i.test(l)) ?? '';
    return line.replace(/^\* SEARCH/i, '').trim().split(/\s+/).filter(Boolean);
  }

  async fetchBody(uid: string): Promise<string> {
    const tag = this.tag();
    this.buffer = Buffer.alloc(0);
    this.write(tag + ' UID FETCH ' + uid + ' (BODY.PEEK[])');
    const done = new RegExp('^' + tag + ' (OK|NO|BAD)', 'm');
    const deadline = Date.now() + 30000;
    for (;;) {
      const text = this.buffer.toString('utf8');
      const literal = text.match(/\{(\d+)\}\r\n/);
      if (literal) {
        const need = text.indexOf('}\r\n') + 3 + Number(literal[1]) + 2;
        if (this.buffer.length >= need && done.test(this.buffer.subarray(need).toString('utf8'))) break;
      }
      if (done.test(text) && !literal) break;
      if (Date.now() > deadline) throw new Error('imap fetch timeout');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('imap fetch timeout')), Math.max(200, deadline - Date.now()));
        this.waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
    const raw = this.buffer.toString('utf8');
    const literal = raw.match(/\{(\d+)\}\r\n/);
    if (!literal) return '';
    const start = raw.indexOf('}\r\n') + 3;
    return raw.slice(start, start + Number(literal[1]));
  }

  async logout(): Promise<void> {
    try { await this.command('LOGOUT', 5000); } catch {}
    try { this.socket?.end(); } catch {}
    this.socket = null;
  }
}

export function parseMime(raw: string): { from: string; subject: string; text: string; html: string[] } {
  const headerEnd = raw.indexOf('\r\n\r\n');
  const head = headerEnd >= 0 ? raw.slice(0, headerEnd) : raw;
  const bodyRaw = headerEnd >= 0 ? raw.slice(headerEnd + 4) : '';
  const decodeHeader = (s: string) => s.replace(/=\?[^?]+\?[BbQq]\?[^?]*\?=/g, (m) => {
    const parts = m.match(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/);
    if (!parts) return m;
    const charset = parts[1];
    const enc = parts[2].toUpperCase();
    const payload = parts[3];
    try {
      if (enc === 'B') return Buffer.from(payload, 'base64').toString(charset.toLowerCase().includes('utf') ? 'utf8' : 'latin1');
      return decodeURIComponent(payload.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, '%$1'));
    } catch { return m; }
  });
  const header = (name: string): string => {
    const m = head.match(new RegExp('^' + name + ':\\s*(.*(?:\\r\\n[ \\t].*)*)', 'im'));
    return m ? decodeHeader(m[1].replace(/\r\n[ \t]/g, ' ').trim()) : '';
  };
  const transfer = (header('Content-Transfer-Encoding') || '').toLowerCase();
  const ctype = header('Content-Type').toLowerCase();
  let body = bodyRaw;
  if (/quoted-printable/.test(transfer)) {
    body = body.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)));
  }
  const html: string[] = [];
  if (ctype.includes('multipart') || /boundary=/.test(ctype)) {
    const bMatch = header('Content-Type').match(/boundary="?([^";]+)"?/i);
    const boundary = bMatch?.[1];
    if (boundary) {
      for (const part of body.split('--' + boundary)) {
        if (/content-type:\s*text\/html/i.test(part)) html.push(part.replace(/^[\s\S]*?\r\n\r\n/, ''));
      }
      body = body.split('--' + boundary).filter((p) => /content-type:\s*text\/plain/i.test(p)).map((p) => p.replace(/^[\s\S]*?\r\n\r\n/, '')).join('\n');
    }
  }
  return { from: header('From'), subject: header('Subject'), text: body, html };
}
