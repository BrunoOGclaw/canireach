// Capture validation and derived aggregates.
//
// A nightly series is only worth anything if every night is comparable to every
// other night. That makes the dangerous failure not "the run crashed" but "the
// run finished and the numbers are wrong" — a truncated append, a dialect that
// silently stopped being sent, a night when our own network was down and the
// whole web looked blocked.
//
// So: nothing is published until it passes these gates, and every gate is
// written so that it CAN fail. `node tools/test-validate.mjs` re-runs the suite
// against deliberately corrupted captures and every corruption must be caught
// by at least one gate.
//
// Expected shape is DERIVED (from the dialect registry and the input list), not
// hand-listed. A hand-listed expectation only covers what its author thought of.

import { readFileSync } from 'node:fs';
import { DIALECTS, SITE_FILES, TOLL_HEADER_NAMES } from './dialects.mjs';

// Keys that must never appear anywhere in a published row, at any depth.
// This is an invariant with a name, not a habit: adding a field to the probe
// that lands in this list fails the gate rather than quietly shipping.
export const FORBIDDEN_KEYS = [
  'body',
  'headers',
  'header_map',
  'cookie',
  'cookies',
  'set_cookie',
  'ua',
  'user_agent',
  'authorization',
  'credentials',
];

// The single exemption, named and shape-checked rather than silent.
//
// `toll.headers` is a list of allowlisted header NAMES that were present — no
// values, no map. The published manifest discloses exactly that. An exemption
// you write down and validate is an exemption; an exemption you achieve by
// removing `headers` from the forbidden list is a hole, because it would also
// permit the generic response-header map this project promises never to store.
export const EXEMPT_PATHS = ['toll.headers'];

// Every outcome the classifier can emit. An outcome outside this set means the
// classifier changed and the aggregates downstream are reading a stale enum.
export const KNOWN_OUTCOMES = [
  'reachable',
  'blocked',
  'challenged',
  'toll',
  'auth_required',
  'rate_limited',
  'legal_block',
  'server_error',
  'client_error',
  'denied_by_robots',
  'error',
  'other',
];

// If fewer than this share of attempted requests are reachable, the likeliest
// explanation is us — our network, our IP, our instrument — not the web. A
// baseline captured through our own outage is worse than a missing night,
// because it is indistinguishable from a real collapse in access.
export const REACHABLE_FLOOR = 0.2;

/**
 * Collect every key with the dotted path it appeared at, so the privacy gate
 * can distinguish `toll.headers` (a disclosed list of names) from `headers`
 * anywhere else (the response-header map we promise never to publish). Array
 * indices are elided from the path: `toll.headers` reads the same whether one
 * row or ten thousand carry it.
 */
function walkKeys(value, out, path = '') {
  if (Array.isArray(value)) {
    for (const v of value) walkKeys(v, out, path);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const here = path ? `${path}.${k}` : k;
      (out[k] ||= new Set()).add(here);
      walkKeys(v, out, here);
    }
  }
}

function bump(obj, key) {
  obj[key] = (obj[key] || 0) + 1;
}

/**
 * Parse a capture into rows, reporting the first line that fails rather than
 * throwing. A partial final line is the signature of an interrupted append, and
 * naming its line number is what makes the failure diagnosable.
 */
export function parseCapture(text) {
  const rows = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (err) {
      return { ok: false, line: i + 1, error: String(err).slice(0, 120), rows };
    }
  }
  return { ok: true, rows };
}

/**
 * Derived aggregates. These are the numbers the map and the MCP tool answer
 * with, so they are computed from the rows every time and never carried by hand
 * — a hand-maintained summary of a growing list drifts, and we have already
 * published that lesson once.
 */
export function aggregate(rows) {
  const requestRows = rows.filter((r) => r.kind === 'request');
  const fileRows = rows.filter((r) => r.kind === 'file');

  const outcomes = {};
  const byDialect = {};
  const challenges = {};
  const tollHeaders = {};
  const robotsPolicy = {};
  const servers = {};

  for (const r of requestRows) {
    bump(outcomes, r.outcome);
    byDialect[r.dialect] ||= { attempted: 0, sent: 0, outcomes: {} };
    const d = byDialect[r.dialect];
    d.attempted++;
    if (r.requested) d.sent++;
    bump(d.outcomes, r.outcome);

    robotsPolicy[r.dialect] ||= { allowed: 0, denied: 0, no_robots: 0 };
    if (!r.robots) robotsPolicy[r.dialect].no_robots++;
    else if (r.robots.allowed) robotsPolicy[r.dialect].allowed++;
    else robotsPolicy[r.dialect].denied++;

    if (r.challenge) bump(challenges, r.challenge);
    if (r.toll) {
      if (r.toll.status_402) bump(tollHeaders, 'status_402');
      // Defensive on shape, not on trust: this function is run against captures
      // that are not yet known to be well-formed, and a validator that throws on
      // malformed input reports a crash where it owes a verdict.
      if (Array.isArray(r.toll.headers)) for (const h of r.toll.headers) bump(tollHeaders, h);
    }
    if (r.server) bump(servers, String(r.server).split('/')[0].toLowerCase());
  }

  // Agent-affordance adoption: the other half of the thesis. A site that
  // publishes llms.txt or agents.md is drawing the detour for us.
  const affordances = {};
  for (const f of SITE_FILES) {
    if (f.id === 'robots') continue;
    const forFile = fileRows.filter((r) => r.file === f.id);
    affordances[f.id] = {
      checked: forFile.length,
      present: forFile.filter((r) => r.present === true).length,
      soft_404: forFile.filter((r) => r.soft_404 === true).length,
      denied_by_robots: forFile.filter((r) => r.outcome === 'denied_by_robots').length,
    };
  }

  const robotsRows = fileRows.filter((r) => r.file === 'robots');

  return {
    rows: rows.length,
    domains: new Set(rows.map((r) => r.domain)).size,
    request_rows: requestRows.length,
    file_rows: fileRows.length,
    requests_sent: requestRows.filter((r) => r.requested).length,
    outcomes,
    by_dialect: byDialect,
    robots_policy: robotsPolicy,
    robots_txt: {
      served_200: robotsRows.filter((r) => r.status === 200).length,
      absent_or_error: robotsRows.filter((r) => r.status !== 200).length,
    },
    affordances,
    challenges,
    toll: tollHeaders,
    top_servers: Object.fromEntries(
      Object.entries(servers)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12),
    ),
  };
}

/**
 * The publish gate. Returns every check with its verdict, so a refusal names
 * what failed instead of just exiting non-zero.
 *
 * `expectedDomains` is the length of the input list; `expectedRowsPerDomain` is
 * derived from the registries so adding a dialect updates the gate by itself.
 */
export function validate(rows, { expectedDomains }) {
  const checks = [];
  const stats = aggregate(rows);
  const expectedRowsPerDomain = DIALECTS.length + SITE_FILES.length;

  const add = (id, ok, detail) => checks.push({ id, ok, detail });

  // 1. Privacy shape. Deep walk: a forbidden key nested inside `toll` or
  //    `robots` is exactly as published as one at the top level. Only the paths
  //    in EXEMPT_PATHS survive, and the exemption is then shape-checked below.
  const paths = {};
  walkKeys(rows, paths);
  const leaked = [];
  for (const k of FORBIDDEN_KEYS) {
    for (const p of paths[k] || []) if (!EXEMPT_PATHS.includes(p)) leaked.push(p);
  }
  add('privacy_shape', leaked.length === 0, leaked.length ? `forbidden key path(s): ${[...new Set(leaked)].join(', ')}` : `no forbidden keys outside ${EXEMPT_PATHS.join(', ')}`);

  // 1b. The exemption's own gate. `toll.headers` may only ever be an array of
  //     allowlisted header NAMES — never a map, never a value. Without this the
  //     exemption would readmit exactly what the invariant forbids.
  const badToll = [];
  for (const r of rows) {
    if (!r.toll || r.toll.headers === undefined) continue;
    if (!Array.isArray(r.toll.headers)) badToll.push(`${r.domain}: toll.headers is ${typeof r.toll.headers}, not an array`);
    else for (const h of r.toll.headers) {
      if (typeof h !== 'string') badToll.push(`${r.domain}: non-string toll header`);
      else if (!TOLL_HEADER_NAMES.includes(h)) badToll.push(`${r.domain}: ${h} not in the published toll allowlist`);
    }
  }
  add(
    'toll_header_shape',
    badToll.length === 0,
    badToll.length ? `${badToll.length} violation(s), e.g. ${badToll.slice(0, 2).join('; ')}` : 'toll.headers is allowlisted names only',
  );

  // 2. Domain coverage against the input list. The first full run stalled at
  //    domain 999 of 1000 and still wrote a file; a count is what catches that.
  add(
    'domain_coverage',
    stats.domains === expectedDomains,
    `${stats.domains} distinct domains, expected ${expectedDomains}`,
  );

  // 3. Per-domain completeness. A domain with 6 rows instead of 10 skews every
  //    rate in the aggregate while the totals still look plausible.
  const perDomain = {};
  for (const r of rows) bump(perDomain, r.domain);
  const short = Object.entries(perDomain).filter(([, n]) => n !== expectedRowsPerDomain);
  add(
    'rows_per_domain',
    short.length === 0,
    short.length
      ? `${short.length} domain(s) not at ${expectedRowsPerDomain} rows, e.g. ${short
          .slice(0, 3)
          .map(([d, n]) => `${d}=${n}`)
          .join(', ')}`
      : `all ${stats.domains} domains at ${expectedRowsPerDomain} rows`,
  );

  // 4. Dialect coverage. A dialect that silently stops being probed makes the
  //    series look like the web changed when the instrument did.
  const missing = DIALECTS.filter((d) => (stats.by_dialect[d.id]?.attempted || 0) !== expectedDomains);
  add(
    'dialect_coverage',
    missing.length === 0,
    missing.length
      ? `dialect(s) not at ${expectedDomains} rows: ${missing.map((d) => `${d.id}=${stats.by_dialect[d.id]?.attempted || 0}`).join(', ')}`
      : `all ${DIALECTS.length} dialects at ${expectedDomains} rows`,
  );

  // 5. One capture, one run label. Two run values in one file means two runs
  //    were appended to the same artifact — which is not hypothetical: the probe
  //    appends, so a reused --out path silently merges last night into tonight.
  const runs = [...new Set(rows.map((r) => r.run))];
  add('run_consistency', runs.length === 1, `run values: ${runs.join(', ') || '(none)'}`);

  // 5b. One capture, one vantage. Access verdicts depend on the IP as much as on
  //     the identity, so a file holding two vantages is not one measurement.
  //     Absent is permitted (captures predating the field) but MIXED is not.
  const vantages = [...new Set(rows.map((r) => r.vantage ?? '(absent)'))];
  add('vantage_consistency', vantages.length === 1, `vantage: ${vantages.join(', ')}`);

  // 6. Known outcomes only.
  const unknown = [...new Set(rows.filter((r) => r.outcome && !KNOWN_OUTCOMES.includes(r.outcome)).map((r) => r.outcome))];
  add('known_outcomes', unknown.length === 0, unknown.length ? `unknown outcome(s): ${unknown.join(', ')}` : 'all outcomes in the published enum');

  // 7. Instrument health. See REACHABLE_FLOOR.
  const sent = stats.requests_sent;
  const reachable = stats.outcomes.reachable || 0;
  const rate = sent ? reachable / sent : 0;
  add(
    'instrument_health',
    sent > 0 && rate >= REACHABLE_FLOOR,
    `${reachable}/${sent} sent requests reachable (${(rate * 100).toFixed(1)}%), floor ${(REACHABLE_FLOOR * 100).toFixed(0)}%`,
  );

  return { ok: checks.every((c) => c.ok), checks, stats };
}

export function validateFile(path, opts) {
  const parsed = parseCapture(readFileSync(path, 'utf8'));
  if (!parsed.ok) {
    return {
      ok: false,
      checks: [{ id: 'json_parse', ok: false, detail: `line ${parsed.line}: ${parsed.error}` }],
      stats: null,
    };
  }
  const result = validate(parsed.rows, opts);
  result.checks.unshift({ id: 'json_parse', ok: true, detail: `${parsed.rows.length} rows parsed` });
  return result;
}

// --- CLI --------------------------------------------------------------------
// node tools/validate.mjs <capture.jsonl> [--list FILE] [--stats]

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const li = args.indexOf('--list');
  const list = li >= 0 && args[li + 1] ? args[li + 1] : 'data/domains/tranco-74V8X-1000.csv';

  if (!file) {
    console.error('usage: node tools/validate.mjs <capture.jsonl> [--list FILE] [--stats]');
    process.exit(2);
  }

  const expectedDomains = readFileSync(list, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.split(',')[1]).length;

  const { ok, checks, stats } = validateFile(file, { expectedDomains });
  for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(18)} ${c.detail}`);
  if (args.includes('--stats') && stats) console.log(JSON.stringify(stats, null, 2));
  if (!ok) {
    console.error('\nCAPTURE REJECTED: not publishable.');
    process.exit(1);
  }
  console.log('\ncapture valid.');
}
