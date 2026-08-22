// The baseline probe.
//
// For each domain, and for each dialect (identity) we can present, record what
// the agent web actually does: the declared policy, and — only where that policy
// permits us — the observed behaviour.
//
// CORE RAIL: we obey robots.txt for the identity we present. Where robots denies
// a token, that denial IS the answer and no request is sent. We never probe past
// a "no". This is a measurement instrument, not an evasion tool.
//
// We record status codes, headers and challenge fingerprints. We do not collect
// or store page content: at most 12 KB of each response is read, scanned for
// interstitial markers, and discarded.
//
// Usage: node tools/probe.mjs [--limit N] [--concurrency N] [--run ID] [--vantage ID] [--out FILE]

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
} from 'node:fs';
import { basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DIALECTS, SITE_FILES, PROBE_CONTACT } from './dialects.mjs';
import { isAllowed, hasExplicitGroup } from './robots.mjs';
import { validateRun } from './finalize-run.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const LIMIT = Number(opt('--limit', '0')) || Infinity;
const CONCURRENCY = Number(opt('--concurrency', '12'));
const LIST = opt('--list', 'data/domains/tranco-74V8X-1000.csv');
const RUN = opt('--run', new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll(':', ''));
const VANTAGE = opt('--vantage', 'local-unspecified');
const OUT = opt('--out', `data/probes/${RUN}.jsonl`);
const PARTIAL = `${OUT}.partial`;

for (const [label, value] of [['run', RUN], ['vantage', VANTAGE]]) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value)) {
    throw new Error(`invalid ${label} identifier: ${value}`);
  }
}
if (basename(OUT) !== `${RUN}.jsonl`) {
  throw new Error(`output filename must match immutable run identity: ${RUN}.jsonl`);
}
if (!Number.isInteger(CONCURRENCY) || CONCURRENCY < 1 || CONCURRENCY > 64) {
  throw new Error('--concurrency must be an integer from 1 to 64');
}
if (LIMIT !== Infinity && (!Number.isInteger(LIMIT) || LIMIT < 1)) {
  throw new Error('--limit must be a positive integer');
}

const TIMEOUT_MS = 12000;
const MAX_BODY = 12 * 1024;
const POLITE_GAP_MS = 300; // between requests to the same host

// --- challenge + toll fingerprints -----------------------------------------
// Ordered: first match wins, so vendor-specific beats generic.
const CHALLENGES = [
  ['cloudflare-challenge', (h, b) => h['cf-mitigated'] === 'challenge' || /cf-chl-|challenge-platform|Just a moment\.\.\./i.test(b)],
  ['datadome', (h, b) => /datadome/i.test(h['set-cookie'] || '') || /datado\.me|DataDome/i.test(b)],
  ['perimeterx', (h, b) => /_px[a-z]*=/i.test(h['set-cookie'] || '') || /perimeterx|px-captcha/i.test(b)],
  ['imperva-incapsula', (h, b) => /incap_ses|visid_incap/i.test(h['set-cookie'] || '') || /Request unsuccessful\. Incapsula/i.test(b)],
  ['akamai', (h, b) => /akamai/i.test(h['server'] || '') && /Reference #|Access Denied/i.test(b)],
  ['hcaptcha', (h, b) => /hcaptcha\.com/i.test(b)],
  ['recaptcha', (h, b) => /recaptcha\/api|g-recaptcha/i.test(b)],
  ['aws-waf', (h, b) => /aws-waf-token/i.test(h['set-cookie'] || '') || /awswaf/i.test(b)],
];

const TOLL_HEADERS = ['crawler-price', 'x-payment', 'x-payment-required', 'x402-price', 'payment-required', 'signature-agent'];

function detectChallenge(headers, body) {
  for (const [name, test] of CHALLENGES) {
    try {
      if (test(headers, body)) return name;
    } catch {
      /* a fingerprint must never take down the run */
    }
  }
  return null;
}

function detectToll(status, headers) {
  const hits = TOLL_HEADERS.filter((h) => headers[h] !== undefined);
  const wwwAuth = headers['www-authenticate'] || '';
  if (/x402|payment|crawler/i.test(wwwAuth)) hits.push('www-authenticate');
  if (status === 402 || hits.length) return { status_402: status === 402, header_names: hits };
  return null;
}

// --- fetch ------------------------------------------------------------------

/**
 * One request. Redirects are recorded but never followed.
 * Returns a plain record; never throws.
 */
export async function probeUrl(url, ua, { readBody = true, fetchImpl = fetch } = {}) {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: ctl.signal,
      headers: { 'user-agent': ua, accept: '*/*', from: PROBE_CONTACT },
    });
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      error: classifyError(err),
      error_detail: String(err?.cause?.code || err?.name || err).slice(0, 80),
      elapsed_ms: Date.now() - started,
    };
  }
  const headers = Object.fromEntries([...res.headers].map(([k, v]) => [k.toLowerCase(), v]));

  // Redirects are observations, never instructions. Following one can cross an
  // origin or land on a path that robots denies, so v2 records the destination
  // host/scheme and makes no second request.
  const loc = headers['location'];
  let redirect = null;
  if (res.status >= 300 && res.status < 400 && loc) {
    try {
      const target = new URL(loc, url);
      const source = new URL(url);
      redirect = {
        target_host: target.host,
        target_scheme: target.protocol.replace(/:$/, ''),
        cross_origin: target.origin !== source.origin,
      };
    } catch {
      redirect = { target_host: null, target_scheme: null, cross_origin: null };
    }
    try { await res.body?.cancel(); } catch { /* already closed */ }
    clearTimeout(timer);
    return {
      ok: true,
      status: res.status,
      final_url: url,
      redirect,
      headers,
      body: '',
      bytes_read: 0,
      elapsed_ms: Date.now() - started,
    };
  }

  let body = '';
  let bytes = 0;
  if (readBody && res.body) {
    try {
      const reader = res.body.getReader();
      const chunks = [];
      while (bytes < MAX_BODY) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        chunks.push(value);
      }
      try { await reader.cancel(); } catch { /* fine */ }
      body = Buffer.concat(chunks).toString('utf8').slice(0, MAX_BODY);
    } catch {
      body = '';
    }
  } else {
    try { await res.body?.cancel(); } catch { /* fine */ }
  }

  // Keep the request deadline alive through the body read. Some origins send
  // headers and then never finish the body.
  clearTimeout(timer);

  return {
    ok: true,
    status: res.status,
    final_url: url,
    redirect: null,
    headers,
    body,
    bytes_read: bytes,
    elapsed_ms: Date.now() - started,
  };
}

function classifyError(err) {
  const code = String(err?.cause?.code || '');
  if (err?.name === 'AbortError') return 'timeout';
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return 'dns';
  if (/CERT|SSL|ERR_TLS|EPROTO/i.test(code)) return 'tls';
  if (/ECONNREFUSED/.test(code)) return 'conn_refused';
  if (/ECONNRESET/.test(code)) return 'conn_reset';
  if (/ETIMEDOUT/.test(code)) return 'conn_timeout';
  return 'other';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- per-domain -------------------------------------------------------------

function unavailableRobotsVerdict(robotsRes) {
  // RFC 9309 permits access when robots.txt is explicitly unavailable (4xx),
  // but this unattended instrument uses the narrower 404/410 signal. Redirects,
  // auth/challenge responses, rate limits, server failures, and network errors
  // leave policy unknown and therefore fail closed.
  if (robotsRes.ok && (robotsRes.status === 404 || robotsRes.status === 410)) {
    return { allowed: true, reason: `robots-http-${robotsRes.status}`, rule: null, group: null };
  }
  return {
    allowed: false,
    reason: robotsRes.ok ? `robots-policy-unknown-http-${robotsRes.status}` : `robots-policy-unknown-${robotsRes.error}`,
    rule: null,
    group: null,
  };
}

export async function probeDomain(rank, domain, { probeUrlImpl = probeUrl, sleepImpl = sleep } = {}) {
  const rows = [];
  const ts = new Date().toISOString();
  const base = { schema_version: 2, ts, run: RUN, vantage: VANTAGE, rank, domain };

  // 1. robots.txt, always, with our own honest identity. robots.txt is the policy
  //    file itself and is never gated by its own contents.
  const ourUa = DIALECTS.find((d) => d.id === 'canireach').ua;
  const robotsRes = await probeUrlImpl(`https://${domain}/robots.txt`, ourUa);
  const robotsOk = robotsRes.ok && robotsRes.status === 200;
  const robotsText = robotsOk ? robotsRes.body : '';

  rows.push({
    ...base,
    kind: 'file',
    file: 'robots',
    status: robotsRes.ok ? robotsRes.status : null,
    error: robotsRes.ok ? null : robotsRes.error,
    bytes: robotsRes.bytes_read ?? 0,
    // A robots.txt that is itself behind a challenge is a finding in its own right.
    challenge: robotsRes.ok ? detectChallenge(robotsRes.headers, robotsRes.body) : null,
    truncated: (robotsRes.bytes_read ?? 0) >= MAX_BODY,
    redirected: robotsRes.ok ? Boolean(robotsRes.redirect) : false,
    redirect_target_host: robotsRes.redirect?.target_host ?? null,
    redirect_target_scheme: robotsRes.redirect?.target_scheme ?? null,
  });

  // 2. Per-dialect: policy verdict first, request only if permitted.
  for (const d of DIALECTS) {
    const verdict = robotsOk
      ? isAllowed(robotsText, d.robots_token, '/')
      : unavailableRobotsVerdict(robotsRes);

    const row = {
      ...base,
      kind: 'request',
      dialect: d.id,
      dialect_kind: d.kind,
      robots: {
        allowed: verdict.allowed,
        reason: verdict.reason,
        rule: verdict.rule,
        group: verdict.group,
        explicit: robotsOk ? hasExplicitGroup(robotsText, d.robots_token) : false,
        known: robotsOk,
      },
    };

    if (!verdict.allowed) {
      // The rail: we do not probe past a "no". The denial is the answer.
      row.requested = false;
      row.outcome = 'denied_by_robots';
      rows.push(row);
      continue;
    }

    const res = await probeUrlImpl(`https://${domain}/`, d.ua);
    row.requested = true;
    if (!res.ok) {
      row.outcome = 'error';
      row.error = res.error;
      row.error_detail = res.error_detail;
      row.elapsed_ms = res.elapsed_ms;
    } else {
      const challenge = detectChallenge(res.headers, res.body);
      const toll = detectToll(res.status, res.headers);
      row.status = res.status;
      row.redirected = Boolean(res.redirect);
      row.redirect_target_host = res.redirect?.target_host ?? null;
      row.redirect_target_scheme = res.redirect?.target_scheme ?? null;
      row.redirect_cross_origin = res.redirect?.cross_origin ?? null;
      row.final_host = safeHost(res.final_url);
      row.challenge = challenge;
      row.toll = toll;
      row.server = res.headers['server'] || null;
      row.x_robots_tag = res.headers['x-robots-tag'] || null;
      row.cf_ray = res.headers['cf-ray'] !== undefined;
      row.elapsed_ms = res.elapsed_ms;
      row.outcome = classifyOutcome(res.status, challenge, toll);
    }
    rows.push(row);
    await sleepImpl(POLITE_GAP_MS);
  }

  // 3. Agent-affordance files, gated on our own token's policy for that path.
  for (const f of SITE_FILES) {
    if (f.id === 'robots') continue; // already done
    const permitted = robotsOk ? isAllowed(robotsText, 'CanIReachBot', f.path).allowed : unavailableRobotsVerdict(robotsRes).allowed;
    if (!permitted) {
      // Keep the schema uniform: a downstream aggregate must never have to
      // distinguish "absent" from "field missing".
      rows.push({ ...base, kind: 'file', file: f.id, status: null, present: false, soft_404: false, outcome: 'denied_by_robots' });
      continue;
    }
    const res = await probeUrlImpl(`https://${domain}${f.path}`, ourUa);
    const verdictFile = classifyFile(f.id, res);
    rows.push({
      ...base,
      kind: 'file',
      file: f.id,
      status: res.ok ? res.status : null,
      error: res.ok ? null : res.error,
      content_type: res.ok ? (res.headers['content-type'] || null) : null,
      present: verdictFile.present,
      soft_404: verdictFile.soft404,
      bytes: res.bytes_read ?? 0,
      redirected: res.ok ? Boolean(res.redirect) : false,
      redirect_target_host: res.redirect?.target_host ?? null,
      redirect_target_scheme: res.redirect?.target_scheme ?? null,
    });
    await sleepImpl(POLITE_GAP_MS);
  }

  return rows;
}

function safeHost(u) {
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
}

/**
 * Is an agent-affordance file actually there?
 *
 * A 200 is not presence. Large sites (facebook.com, measured 2026-08-22) serve a
 * ~300 KB SPA shell at 200 for every unknown path, so `status === 200` would have
 * reported them as publishing both llms.txt and agents.md. The soft-404 is
 * recorded rather than silently dropped: a site that answers 200 to everything is
 * itself hostile to agents, and that is a finding.
 */
function classifyFile(id, res) {
  if (!res.ok || res.status !== 200) return { present: false, soft404: false };
  const ctype = (res.headers['content-type'] || '').toLowerCase();
  const body = (res.body || '').trimStart().slice(0, 400).toLowerCase();
  const looksHtml = /^<!doctype html|^<html/.test(body) || ctype.startsWith('text/html');

  if (id === 'web_bot_auth') {
    // A JWKS-shaped signature directory. HTML here is a soft-404.
    if (looksHtml) return { present: false, soft404: true };
    return { present: /application\/(json|http-message-signatures-directory)/.test(ctype) || body.startsWith('{'), soft404: false };
  }
  // llms.txt / agents.md are plain text or markdown by spec.
  if (looksHtml) return { present: false, soft404: true };
  return { present: true, soft404: false };
}

// Exported so tools/test-reports.mjs can derive the outcome vocabulary by
// RUNNING this classifier rather than by reading the list beside it. A crowd
// report has to be spelled the way a capture is spelled or it can never be
// matched against one, and two lists drifting apart would disable corroboration
// without failing anything.
export function classifyOutcome(status, challenge, toll) {
  if (challenge) return 'challenged';
  if (toll) return 'toll';
  if (status >= 300 && status < 400) return 'redirected';
  if (status === 402) return 'toll';
  if (status === 401) return 'auth_required';
  if (status === 403) return 'blocked';
  if (status === 429) return 'rate_limited';
  if (status === 451) return 'legal_block';
  if (status >= 200 && status < 300) return 'reachable';
  if (status >= 500) return 'server_error';
  // 400 is common when a site rejects an agent-shaped request outright
  // (facebook.com does this to a cookieless desktop UA).
  if (status >= 400 && status < 500) return 'client_error';
  return 'other';
}

// --- runner -----------------------------------------------------------------

function loadDomains() {
  const raw = readFileSync(LIST, 'utf8').trim().split(/\r?\n/);
  const out = [];
  for (const line of raw) {
    const [rank, domain] = line.split(',');
    if (!domain) continue;
    out.push([Number(rank), domain.trim()]);
    if (out.length >= LIMIT) break;
  }
  return out;
}

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  if (existsSync(OUT)) throw new Error(`refusing to replace completed capture: ${OUT}`);
  const domains = loadDomains();
  if (domains.length === 0) {
    const err = new Error('REFUSING TO START: input list produced zero domains.');
    err.exitCode = 3;
    throw err;
  }
  const outputFd = openSync(PARTIAL, 'wx');

  const started = Date.now();
  let done = 0;
  let written = 0;
  const counts = Object.create(null);

  const queue = [...domains];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const [rank, domain] = item;
      let rows;
      try {
        rows = await probeDomain(rank, domain);
      } catch (err) {
        rows = [{ ts: new Date().toISOString(), run: RUN, rank, domain, kind: 'error', error: String(err).slice(0, 200) }];
      }
      // Append-only. One write per domain keeps rows for a domain contiguous.
      appendFileSync(outputFd, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      written += rows.length;
      for (const r of rows) if (r.kind === 'request') counts[r.outcome] = (counts[r.outcome] || 0) + 1;
      done++;
      if (done % 25 === 0 || done === domains.length) {
        const rate = done / ((Date.now() - started) / 1000);
        process.stderr.write(`  ${done}/${domains.length} domains  ${written} rows  ${rate.toFixed(1)}/s\n`);
      }
    }
  });

  const settled = await Promise.allSettled(workers);
  const rejected = settled.find((result) => result.status === 'rejected');
  if (rejected) {
    closeSync(outputFd);
    throw rejected.reason;
  }

  console.log(`\nprobe run ${RUN}: ${done} domains, ${written} rows -> ${PARTIAL}`);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(18)} ${String(v).padStart(6)}  ${((v / total) * 100).toFixed(1)}%`);
  }

  // A run that produced no request rows is a broken instrument, not a quiet web.
  const expectedRows = domains.length * (DIALECTS.length + SITE_FILES.length);
  const expectedRequests = domains.length * DIALECTS.length;
  if (total !== expectedRequests || written !== expectedRows) {
    closeSync(outputFd);
    const err = new Error(
      `REFUSING TO FINALIZE: expected ${expectedRows} rows/${expectedRequests} requests, got ${written}/${total}`,
    );
    err.exitCode = 3;
    throw err;
  }

  fsyncSync(outputFd);
  closeSync(outputFd);
  validateRun(PARTIAL, { run: RUN, list: LIST, vantage: VANTAGE, allowPartial: true, limit: LIMIT });
  renameSync(PARTIAL, OUT);
  console.log(`finalized immutable capture -> ${OUT}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(err?.exitCode || 1);
  });
}
