import fs from 'node:fs/promises';
import path from 'node:path';
import { safeJson } from './util.ts';

export const rootDir = process.cwd();
export const dataDir = path.join(rootDir, 'data');
export const reportDir = path.join(dataDir, 'reports');
export const stateDir = path.join(dataDir, 'state');

export async function ensureDirs(): Promise<void> {
  for (const d of [dataDir, reportDir, stateDir]) await fs.mkdir(d, { recursive: true });
}

export async function writeJson(rel: string, value: unknown): Promise<string> {
  const p = path.isAbsolute(rel) ? rel : path.join(rootDir, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(value, null, 2) + '\n', 'utf8');
  return p;
}

export async function readJson<T = unknown>(rel: string): Promise<T | undefined> {
  const p = path.isAbsolute(rel) ? rel : path.join(rootDir, rel);
  try {
    const text = await fs.readFile(p, 'utf8');
    return safeJson<T>(text);
  } catch { return undefined; }
}

export async function exists(rel: string): Promise<boolean> {
  try { await fs.access(path.isAbsolute(rel) ? rel : path.join(rootDir, rel)); return true; } catch { return false; }
}

export async function appendLine(rel: string, line: string): Promise<void> {
  const p = path.isAbsolute(rel) ? rel : path.join(rootDir, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.appendFile(p, line.endsWith('\n') ? line : line + '\n', 'utf8');
}
