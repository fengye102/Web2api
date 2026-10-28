import { probeSite, summarize } from './recon/probe.ts';
import type { ProbeReport } from './recon/probe.ts';
import { writeJson, readJson, ensureDirs, reportDir, dataDir } from './core/store.ts';
import { fmtTable, hostOf, bar } from './core/util.ts';
import { hunt, probeAccountCredits, confirmAccount, probeAccountChat } from './hunt/runner.ts';
import { runHarvest, renderHarvestMarkdown } from './harvest/fodder.ts';
import { startGateway } from './gateway/server.ts';
import { trialProbe } from './hunt/sites.ts';
import { ensureSiteConfig } from './hunt/discover.ts';
import path from 'node:path';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = new Map<string, string>();
const positional: string[] = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    if (eq > 0) flags.set(a.slice(2, eq), a.slice(eq + 1));
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags.set(a.slice(2), argv[++i]);
    else flags.set(a.slice(2), 'true');
  } else positional.push(a);
}

const DEFAULT_SITES = ['https://www.uhelp.ai/', 'https://www.palvoro.com/', 'https://aethyro.com/', 'https://superapp.chat/'];

function reportName(site: string): string {
  return path.join(reportDir, hostOf(site).replace(/[^a-z0-9.\-]/gi, '_') + '.json');
}

async function cmdProbe(): Promise<void> {
  await ensureDirs();
  const sites = positional.length ? positional : DEFAULT_SITES;
  const rows: string[][] = [['site', 'status', 'score', 'verdict', 'stack', 'auth', 'models']];
  for (const site of sites) {
    const report = await probeSite(site);
    await writeJson(reportName(site), report);
    rows.push([hostOf(site), String(report.status), String(report.score) + ' ' + bar(report.score, 8), report.verdict, report.stack.slice(0, 3).join('+') || '-', report.supabase ? 'supabase' : report.auth0 ? 'auth0' : '-', String(report.models.length)]);
    console.log(summarize(report));
    console.log('  report: ' + path.relative(process.cwd(), reportName(site)));
    console.log('');
  }
  console.log(fmtTable(rows));
}

async function cmdDiscover(): Promise<void> {
  await ensureDirs();
  const site = positional[0];
  if (!site) throw new Error('usage: discover <site>');
  const report = await probeSite(site, { routeLimit: 14, assetLimit: 40 });
  await writeJson(reportName(site), report);
  console.log(summarize(report));
  console.log('routes: ' + report.routes.map((r) => r.path + '(' + r.status + ')').join(' '));
  console.log('endpoints:');
  for (const e of report.endpoints.slice(0, 25)) console.log('  ' + String(e.score).padStart(3) + '  ' + e.endpoint + '  [' + e.source + ']');
  if (report.secrets.length) {
    console.log('secrets:');
    for (const s of report.secrets.slice(0, 10)) console.log('  ' + s.kind + ' = ' + s.value.slice(0, 60) + (s.value.length > 60 ? '…' : ''));
  }
  const cfg = await ensureSiteConfig(site, { refresh: true });
  console.log('site config: supabase=' + (cfg.supabase ? cfg.supabase.url + (cfg.supabase.anon_key ? ' +anon' : '') : '-') + ' auth0=' + (cfg.auth0 ? cfg.auth0.domain : '-'));
  console.log('report: ' + path.relative(process.cwd(), reportName(site)));
}

async function cmdReport(): Promise<void> {
  await ensureDirs();
  const sites = positional.length ? positional : DEFAULT_SITES;
  for (const site of sites) {
    const r = await readJson<ProbeReport>(reportName(site));
    if (!r) { console.log(hostOf(site) + ': no report'); continue; }
    console.log(summarize(r));
  }
}

async function cmdTrial(): Promise<void> {
  const site = positional[0] ?? 'https://aethyro.com/';
  const cfg = await ensureSiteConfig(site);
  const r = await trialProbe(cfg, flags.get('message') ?? 'say PONG');
  console.log('trial-chat -> ' + r.status + ' ' + r.text.slice(0, 300));
}

async function cmdHunt(): Promise<void> {
  await ensureDirs();
  const site = positional[0];
  if (!site) throw new Error('usage: hunt <site> [--provider=mail.tm] [--skip-confirm]');
  const result = await hunt(site, {
    provider: flags.get('provider'),
    domain: flags.get('domain'),
    retry429: Number(flags.get('retry429') ?? 0),
    retryDelayMs: Number(flags.get('retry-delay') ?? 60000),
    password: flags.get('password'),
    confirmTimeoutMs: Number(flags.get('confirm-timeout') ?? 150000),
    skipConfirm: flags.has('skip-confirm'),
    refreshConfig: flags.has('refresh')
  });
  console.log('site: ' + result.host + '  [' + result.label + ']');
  console.log('ok: ' + result.ok + '  status: ' + (result.account?.status ?? '-'));
  console.log('mailbox: ' + (result.mailbox?.address ?? '-') + '  (' + (result.mailbox?.provider ?? '-') + ')');
  console.log('message: ' + result.message);
  if (result.account) {
    console.log('account: ' + result.account.email + '  token=' + (result.account.access_token ? 'yes' : 'no'));
    console.log('note: ' + result.account.note);
  }
}

async function cmdVerify(): Promise<void> {
  await ensureDirs();
  const site = positional[0];
  const email = flags.get('email');
  if (!site || !email) throw new Error('usage: verify <site> --email=<address>');
  const result = await confirmAccount(site, email, { confirmTimeoutMs: Number(flags.get('confirm-timeout') ?? 120000) });
  console.log('ok: ' + result.ok + '  status: ' + (result.account?.status ?? '-'));
  console.log('message: ' + result.message);
  if (result.account) console.log('note: ' + result.account.note);
}

async function cmdCredits(): Promise<void> {
  await ensureDirs();
  const site = positional[0];
  if (!site) throw new Error('usage: credits <site> [--email=...]');
  console.log(await probeAccountCredits(site, flags.get('email')));
}

async function cmdChat(): Promise<void> {
  await ensureDirs();
  const site = positional[0];
  if (!site) throw new Error('usage: chat <site> [--email=...]');
  console.log(await probeAccountChat(site, flags.get('email')));
}

async function cmdHarvest(): Promise<void> {
  await ensureDirs();
  const base = flags.get('base') ?? process.env.W2A_LLM_BASE ?? '';
  const key = flags.get('key') ?? process.env.W2A_LLM_KEY ?? '';
  const { candidates } = await runHarvest({
    base: base || undefined,
    key: key || undefined,
    model: flags.get('model') ?? process.env.W2A_LLM_MODEL ?? undefined,
    limit: Number(flags.get('limit') ?? 24),
    probeLimit: Number(flags.get('probe-limit') ?? 12)
  });
  const md = renderHarvestMarkdown(candidates);
  await writeJson('data/harvest.md', md);
  console.log(md);
  console.log('');
  console.log('candidates: ' + path.relative(process.cwd(), 'data/candidates.json') + '  report: ' + path.relative(process.cwd(), 'data/harvest.md'));
}

async function cmdServe(): Promise<void> {
  await ensureDirs();
  const overrides: Record<string, unknown> = {};
  if (flags.get('port')) overrides.port = Number(flags.get('port'));
  if (flags.get('host')) overrides.host = flags.get('host');
  if (flags.get('key') !== undefined) overrides.api_key = flags.get('key');
  if (flags.get('upstream')) overrides.default_upstream = flags.get('upstream');
  const gw = await startGateway(overrides);
  console.log('');
  console.log('  gateway   ' + gw.url);
  console.log('  models    GET  ' + gw.url + '/v1/models');
  console.log('  chat      POST ' + gw.url + '/v1/chat/completions');
  console.log('  health    GET  ' + gw.url + '/health');
  console.log('  stats     GET  ' + gw.url + '/v1/stats');
  console.log('  admin     GET  ' + gw.url + '/admin/config | /admin/logs | POST /admin/reload');
  console.log('');
  const stop = async () => { await gw.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

const HELP = [
  'usage: node src/cli.ts <command> [args] [--flag=value]',
  '',
  'commands:',
  '  probe [sites...]      recon: stack, auth backend, leaked keys, endpoints, models',
  '  discover <site>       deep recon + persist data/sites/<host>.json',
  '  report [sites...]     print stored recon reports',
  '  trial [site]          hit the anonymous trial-chat endpoint',
  '  hunt <site>           temp-mail signup + confirmation + session capture',
  '  credits <site>        check a stored account against the credit endpoint',
  '  chat <site>           hit the site chat endpoint with a stored account',
  '  harvest               generate + probe candidate sites (焚诀 prompt / seeds)',
  '  serve                 OpenAI-compatible gateway',
  '',
  'env:',
  '  W2A_KEY               gateway bearer key (blank = open on localhost)',
  '  W2A_UPSTREAM_BASE     optional OpenAI-compatible upstream fed into the pool',
  '  W2A_LLM_BASE/KEY/MODEL  LLM used by harvest to generate candidates',
  ''
].join('\n');

async function main(): Promise<void> {
  switch (cmd) {
    case 'probe': return cmdProbe();
    case 'discover': return cmdDiscover();
    case 'report': return cmdReport();
    case 'trial': return cmdTrial();
    case 'hunt': return cmdHunt();
    case 'verify': return cmdVerify();
    case 'credits': return cmdCredits();
    case 'chat': return cmdChat();
    case 'harvest': return cmdHarvest();
    case 'serve': return cmdServe();
    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  console.error('error: ' + (e?.stack ?? e));
  process.exit(1);
});
