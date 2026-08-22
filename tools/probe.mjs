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
// Usage: node tools/probe.mjs [--limit N] [--concurrency N] [--out FILE]

import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DIALECTS, SITE_FILES, PROBE_CONTACT } from './dialects.mjs';
import { isAllowed, hasExplicitGroup } from './robots.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const LIMIT = Number(opt('--limit', '0')) || Infinity;
const CONCURRENCY = Number(opt('--concurrency', '12'));
const LIST = opt('--list', 'data/domains/tranco-74V8X-1000.csv');
const RUN = new Date().toISOString().slice(0, 10);
const OUT = opt('--out', `data/probes/${RUN}.jsonl`);

const TIMEOUT_MS = 12000;
const MAX_BODY = 12 * 1024;
const MAX_REDIRECTS = 5;
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
  if (status === 402 || hits.length) return { status_402: status === 402, headers: hits };
  return null;
}

// --- fetch ------------------------------------------------------------------

/**
 * One request, following redirects manually so the chain is observable.
 * Returns a plain record; never throws.
 */
async function probeUrl(url, ua, { readBody = true } = {}) {
  const chain = [];
  let current = url;
  const started = Date.now();

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(current, {
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
        chain,
        elapsed_ms: Date.now() - started,
      };
    }
    clearTimeout(timer);

    const headers = Object.fromEntries([...res.headers].map(([k, v]) => [k.toLowerCase(), v]));
    chain.push({ url: current, status: res.status });

    const loc = headers['location'];
    if (res.status >= 300 && res.status < 400 && loc && hop < MAX_REDIRECTS) {
      try {
        current = new URL(loc, current).toString();
      } catch {
        break;
      }
      // Do not carry a body read across a redirect.
      try { await res.body?.cancel(); } catch { /* already closed */ }
      continue;
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

    return {
      ok: true,
      status: res.status,
      final_url: current,
      redirects: chain.length - 1,
      chain: chain.length > 1 ? chain : undefined,
      headers,
      body,
      bytes_read: bytes,
      elapsed_ms: Date.now() - started,
    };
  }
  return { ok: false, error: 'redirect_loop', chain, elapsed_ms: Date.now() - started };
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

async function probeDomain(rank, domain) {
  const rows = [];
  const ts = new Date().toISOString();
  const base = { ts, run: RUN, rank, domain };

  // 1. robots.txt, always, with our own honest identity. robots.txt is the policy
  //    file itself and is never gated by its own contents.
  const ourUa = DIALECTS.find((d) => d.id === 'canireach').ua;
  const robotsRes = await probeUrl(`https://${domain}/robots.txt`, ourUa);
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
  });

  // 2. Per-dialect: policy verdict first, request only if permitted.
  for (const d of DIALECTS) {
    const verdict = robotsOk
      ? isAllowed(robotsText, d.robots_token, '/')
      : { allowed: true, reason: robotsRes.ok ? `robots-http-${robotsRes.status}` : `robots-${robotsRes.error}`, rule: null, group: null };

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

    const res = await probeUrl(`https://${domain}/`, d.ua);
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
      row.redirects = res.redirects;
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
    await sleep(POLITE_GAP_MS);
  }

  // 3. Agent-affordance files, gated on our own token's policy for that path.
  for (const f of SITE_FILES) {
    if (f.id === 'robots') continue; // already done
    const permitted = robotsOk ? isAllowed(robotsText, 'CanIReachBot', f.path).allowed : true;
    if (!permitted) {
      // Keep the schema uniform: a downstream aggregate must never have to
      // distinguish "absent" from "field missing".
      rows.push({ ...base, kind: 'file', file: f.id, status: null, present: false, soft_404: false, outcome: 'denied_by_robots' });
      continue;
    }
    const res = await probeUrl(`https://${domain}${f.path}`, ourUa);
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
      redirects: res.ok ? res.redirects : undefined,
    });
    await sleep(POLITE_GAP_MS);
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

function classifyOutcome(status, challenge, toll) {
  if (challenge) return 'challenged';
  if (toll) return 'toll';
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
  const domains = loadDomains();
  mkdirSync(dirname(OUT), { recursive: true });

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
      appendFileSync(OUT, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      written += rows.length;
      for (const r of rows) if (r.kind === 'request') counts[r.outcome] = (counts[r.outcome] || 0) + 1;
      done++;
      if (done % 25 === 0 || done === domains.length) {
        const rate = done / ((Date.now() - started) / 1000);
        process.stderr.write(`  ${done}/${domains.length} domains  ${written} rows  ${rate.toFixed(1)}/s\n`);
      }
    }
  });

  await Promise.all(workers);

  console.log(`\nprobe run ${RUN}: ${done} domains, ${written} rows -> ${OUT}`);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(18)} ${String(v).padStart(6)}  ${((v / total) * 100).toFixed(1)}%`);
  }

  // A run that produced no request rows is a broken instrument, not a quiet web.
  if (total === 0) {
    console.error('REFUSING TO REPORT SUCCESS: zero request rows written.');
    process.exit(3);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
