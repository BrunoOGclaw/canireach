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
import { ROW_SCHEMA_VERSION } from './policy.mjs';

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

// --- robots.txt retrieval ---------------------------------------------------
//
// THE PROBE TARGET AND robots.txt GET DIFFERENT REDIRECT POLICIES, ON PURPOSE.
//
// For the probe target, a redirect is an observation and never an instruction:
// following one can cross an origin or land on a path whose own robots verdict
// we have not asked for. That stays `recorded-never-followed`.
//
// robots.txt is not a destination, it is the policy document, and RFC 9309
// §2.3.1.2 addresses its redirects explicitly:
//
//   "The crawlers SHOULD follow at least five consecutive redirects, even
//    across authorities (for example, hosts in the case of HTTP). If a
//    robots.txt file is reached within five consecutive redirects, the
//    robots.txt file MUST be fetched, parsed, and its rules followed in the
//    context of the initial authority. If there are more than five consecutive
//    redirects, crawlers MAY assume that the robots.txt file is unavailable."
//
// Treating those redirects as unreadable policy was a CONFORMANCE GAP, and it
// was not a small one. Measured on the 2026-08-22T162332Z capture: 452 of the
// top 1,000 domains redirect robots.txt, 374 of them to their own `www.` host,
// and every one of those domains contributed five `not-attempted` doors that a
// careless reader would count as the web refusing us. Only 195 domains carried
// any behavioural evidence at all. The refusal was ours, not theirs.
//
// "In the context of the initial authority" is the load-bearing clause: the
// rules fetched from `www.example.com` govern requests to `example.com`, and we
// still send those requests to the initial authority. Following the policy
// document is not the same as following the site.

export const ROBOTS_MAX_REDIRECTS = 5;

/**
 * Hosts we refuse to follow a redirect to, matched on literal addresses only.
 *
 * This instrument runs unattended on a hosted runner, and a redirect is an
 * instruction from a third party. `Location: http://169.254.169.254/` is the
 * textbook shape, and refusing it costs nothing real: no site's robots.txt
 * redirects to loopback or link-local space. A hostname that RESOLVES into
 * private space is not covered here — that is a DNS-level problem shared with
 * every domain on the list, not something this function can honestly claim.
 */
export function isPrivateHostLiteral(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.startsWith('[')) {
    const v6 = host.slice(1, -1);
    // loopback, unspecified, unique-local (fc00::/7), link-local (fe80::/10)
    return v6 === '::1' || v6 === '::' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const [a, b] = v4.slice(1).map(Number);
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}

/** Where does this redirect point, and may we follow it? */
function redirectTarget(res, fromUrl) {
  const loc = res.headers?.['location'];
  if (!loc) return { refusal: 'redirect-no-location' };
  let target;
  try {
    target = new URL(loc, fromUrl);
  } catch {
    return { refusal: 'redirect-unparseable-location' };
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return { refusal: 'redirect-unsupported-scheme' };
  }
  if (isPrivateHostLiteral(target.hostname)) return { refusal: 'redirect-refused-private-target' };
  return { url: target };
}

/**
 * Fetch robots.txt, following up to ROBOTS_MAX_REDIRECTS consecutive redirects.
 *
 * Returns the TERMINAL response plus the chain that led to it, so the decision
 * is auditable from the published bytes rather than from this comment. A
 * `refusal` means we stopped following and policy stays unknown: it fails
 * closed exactly like an unreadable robots.txt, because that is what it is.
 */
export async function fetchRobots(domain, ua, { probeUrlImpl = probeUrl, sleepImpl = sleep } = {}) {
  const start = `https://${domain}/robots.txt`;
  let url = start;
  const chain = [];
  const seen = new Set([start]);

  for (;;) {
    const res = await probeUrlImpl(url, ua);
    const done = (refusal) => ({ res, chain, hops: chain.length, final_url: url, refusal });
    if (!res.ok || !(res.status >= 300 && res.status < 400)) return done(null);

    const next = redirectTarget(res, url);
    chain.push({
      status: res.status,
      target_host: next.url ? next.url.host : (res.redirect?.target_host ?? null),
      target_scheme: next.url ? next.url.protocol.replace(/:$/, '') : (res.redirect?.target_scheme ?? null),
      cross_authority: next.url ? next.url.host !== new URL(url).host : null,
    });

    // The hop is recorded BEFORE the budget check: a sixth redirect is an
    // observation about the site, and a chain that stopped one short of the
    // reason it stopped would be unauditable.
    if (chain.length > ROBOTS_MAX_REDIRECTS) return done('redirect-exhausted');
    if (next.refusal) return done(next.refusal);
    if (seen.has(next.url.href)) return done('redirect-loop');

    seen.add(next.url.href);
    url = next.url.href;
    await sleepImpl(POLITE_GAP_MS);
  }
}

// --- per-domain -------------------------------------------------------------

function unavailableRobotsVerdict(robotsRes, refusal = null) {
  // RFC 9309 permits access when robots.txt is explicitly unavailable (4xx),
  // but this unattended instrument uses the narrower 404/410 signal. Auth and
  // challenge responses, rate limits, server failures, network errors, and
  // redirects we could not resolve to a policy document all leave policy
  // unknown and therefore fail closed.
  //
  // The 404/410 test comes first and reads the TERMINAL response: a robots.txt
  // that redirects to a 404 is an explicitly absent policy, not an unknown one.
  if (robotsRes.ok && (robotsRes.status === 404 || robotsRes.status === 410)) {
    return { allowed: true, reason: `robots-http-${robotsRes.status}`, rule: null, group: null };
  }
  // Every spelling here carries `policy-unknown`, which is the substring
  // tools/aggregate.mjs counts on to separate "the site said no" from "we could
  // not read the site's answer". A refusal that lost it would be silently
  // recounted as a denial by the host.
  const reason = refusal
    ? `robots-policy-unknown-${refusal}`
    : robotsRes.ok
      ? `robots-policy-unknown-http-${robotsRes.status}`
      : `robots-policy-unknown-${robotsRes.error}`;
  return { allowed: false, reason, rule: null, group: null };
}

export async function probeDomain(rank, domain, { probeUrlImpl = probeUrl, sleepImpl = sleep } = {}) {
  const rows = [];
  const ts = new Date().toISOString();
  const base = { schema_version: ROW_SCHEMA_VERSION, ts, run: RUN, vantage: VANTAGE, rank, domain };

  // 1. robots.txt, always, with our own honest identity. robots.txt is the policy
  //    file itself and is never gated by its own contents. Redirects to it are
  //    followed (RFC 9309 §2.3.1.2); redirects to anything else are not.
  const ourUa = DIALECTS.find((d) => d.id === 'canireach').ua;
  const robots = await fetchRobots(domain, ourUa, { probeUrlImpl, sleepImpl });
  const robotsRes = robots.res;
  const robotsOk = !robots.refusal && robotsRes.ok && robotsRes.status === 200;
  const robotsText = robotsOk ? robotsRes.body : '';
  const lastHop = robots.chain[robots.chain.length - 1] ?? null;

  rows.push({
    ...base,
    kind: 'file',
    file: 'robots',
    // The status of the response the policy was READ FROM, which is the whole
    // point of following: after a 301 to www, `200` is the honest answer and
    // `301` was an answer about the redirect, not about the policy.
    status: robotsRes.ok ? robotsRes.status : null,
    error: robotsRes.ok ? null : robotsRes.error,
    bytes: robotsRes.bytes_read ?? 0,
    // A robots.txt that is itself behind a challenge is a finding in its own right.
    challenge: robotsRes.ok ? detectChallenge(robotsRes.headers, robotsRes.body) : null,
    truncated: (robotsRes.bytes_read ?? 0) >= MAX_BODY,
    redirected: robots.hops > 0,
    redirect_hops: robots.hops,
    // The full chain, so a reader can audit which authority actually answered
    // instead of taking this instrument's word for it.
    redirect_chain: robots.chain,
    redirect_target_host: lastHop?.target_host ?? null,
    redirect_target_scheme: lastHop?.target_scheme ?? null,
    final_host: safeHost(robots.final_url),
    redirect_refusal: robots.refusal,
  });

  // 2. Per-dialect: policy verdict first, request only if permitted.
  for (const d of DIALECTS) {
    const verdict = robotsOk
      ? isAllowed(robotsText, d.robots_token, '/')
      : unavailableRobotsVerdict(robotsRes, robots.refusal);

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
    const permitted = robotsOk
      ? isAllowed(robotsText, 'CanIReachBot', f.path).allowed
      : unavailableRobotsVerdict(robotsRes, robots.refusal).allowed;
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
