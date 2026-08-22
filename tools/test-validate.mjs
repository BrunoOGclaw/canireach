// Tests for the capture gates and the derived aggregates.
//
// The structure that matters is at the bottom: a synthetic capture that passes
// every gate, then one deliberate corruption per gate, each of which must be
// caught BY THAT GATE. A suite that only checks the happy path proves the gates
// run, not that they can fail — and a gate that cannot fail is worse than no
// gate, because it publishes a green tick.
//
// Run: node tools/test-validate.mjs

import { validate, aggregate, parseCapture, REACHABLE_FLOOR } from './validate.mjs';
import { DIALECTS, SITE_FILES } from './dialects.mjs';

let pass = 0;
const failures = [];

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else failures.push(`${label}\n     expected ${e}\n     actual   ${a}`);
}

function ok(cond, label) {
  if (cond) pass++;
  else failures.push(label);
}

// --- a synthetic capture ----------------------------------------------------
// Shaped exactly like a real one: for each domain, one row per dialect and one
// per site file. `reachable` is dialed high enough to clear the health floor so
// that the floor is tested by a corruption rather than by accident.

const DOMAINS = ['a.example', 'b.example', 'c.example', 'd.example', 'e.example'];

function buildCapture({ domains = DOMAINS, run = '2026-08-22' } = {}) {
  const rows = [];
  domains.forEach((domain, i) => {
    const base = { ts: '2026-08-22T08:00:00.000Z', run, rank: i + 1, domain };
    for (const d of DIALECTS) {
      // One domain in five is robots-denied; the rest are reachable.
      const denied = i === 4;
      rows.push({
        ...base,
        kind: 'request',
        dialect: d.id,
        dialect_kind: d.kind,
        robots: { allowed: !denied, reason: denied ? 'disallow-rule' : 'allow-default' },
        requested: !denied,
        ...(denied
          ? { outcome: 'denied_by_robots' }
          : {
              status: 200,
              outcome: 'reachable',
              server: i === 0 ? 'cloudflare' : 'nginx/1.24',
              challenge: null,
              toll: null,
              cf_ray: i === 0,
            }),
      });
    }
    for (const f of SITE_FILES) {
      if (f.id === 'robots') {
        rows.push({ ...base, kind: 'file', file: 'robots', status: 200, error: null, bytes: 120, truncated: false });
        continue;
      }
      rows.push({
        ...base,
        kind: 'file',
        file: f.id,
        status: i < 2 ? 200 : 404,
        present: i < 2,
        soft_404: false,
      });
    }
  });
  return rows;
}

const OPTS = { expectedDomains: DOMAINS.length };
const clone = (rows) => rows.map((r) => JSON.parse(JSON.stringify(r)));

// --- parse ------------------------------------------------------------------

eq(parseCapture('{"a":1}\n{"b":2}\n').rows.length, 2, 'parses two rows');
eq(parseCapture('{"a":1}\n\n\n{"b":2}\n').rows.length, 2, 'blank lines are not rows');
eq(parseCapture('{"a":1}\n{"b":').ok, false, 'a truncated final line is a parse failure');
eq(parseCapture('{"a":1}\n{"b":').line, 2, 'the failing line is named');

// --- aggregates -------------------------------------------------------------
// Asserted against hand-counted values from the generator above, not against a
// second call to the same function.

const rows = buildCapture();
const stats = aggregate(rows);

eq(stats.rows, 5 * (DIALECTS.length + SITE_FILES.length), 'row count');
eq(stats.domains, 5, 'distinct domains');
eq(stats.request_rows, 5 * DIALECTS.length, 'request rows');
eq(stats.file_rows, 5 * SITE_FILES.length, 'file rows');
eq(stats.requests_sent, 4 * DIALECTS.length, 'one robots-denied domain is never sent');
eq(stats.outcomes.reachable, 4 * DIALECTS.length, 'reachable count');
eq(stats.outcomes.denied_by_robots, DIALECTS.length, 'denied count');
eq(stats.by_dialect.canireach.attempted, 5, 'per-dialect attempted');
eq(stats.by_dialect.canireach.sent, 4, 'per-dialect sent excludes robots denials');
eq(stats.robots_policy.gptbot, { allowed: 4, denied: 1, no_robots: 0 }, 'robots policy split');
eq(stats.affordances.llms_txt, { checked: 5, present: 2, soft_404: 0, denied_by_robots: 0 }, 'affordance adoption');
eq(stats.robots_txt, { served_200: 5, absent_or_error: 0 }, 'robots.txt availability');
// 3 nginx domains and 1 cloudflare domain report a server; the robots-denied
// domain sends no request and so contributes no server at all.
eq(stats.top_servers, { nginx: 3 * DIALECTS.length, cloudflare: DIALECTS.length }, 'servers ranked by frequency');

// A challenge and a toll must actually reach the aggregate, so the map cannot
// silently report zero challenges on a challenged web.
const withChallenge = clone(rows);
withChallenge[0].challenge = 'cloudflare-challenge';
withChallenge[0].outcome = 'challenged';
withChallenge[1].toll = { status_402: true, headers: ['crawler-price'] };
withChallenge[1].outcome = 'toll';
const cstats = aggregate(withChallenge);
eq(cstats.challenges, { 'cloudflare-challenge': 1 }, 'challenge vendors counted');
eq(cstats.toll, { status_402: 1, 'crawler-price': 1 }, 'toll signals counted by kind');

// --- the positive control ---------------------------------------------------
// If this is not green, every corruption below is "caught" by an already-failing
// gate and the whole suite means nothing.

const base = validate(rows, OPTS);
ok(base.ok, `POSITIVE CONTROL: a clean capture must pass every gate — failed: ${base.checks.filter((c) => !c.ok).map((c) => `${c.id} (${c.detail})`).join('; ')}`);

// --- one corruption per gate ------------------------------------------------

function corrupt(label, expectedGate, mutate) {
  const mutated = mutate(clone(rows));
  const result = validate(mutated, OPTS);
  const failed = result.checks.filter((c) => !c.ok).map((c) => c.id);
  if (result.ok) {
    failures.push(`${label}: NOT CAUGHT — capture still passed every gate`);
    return;
  }
  if (!failed.includes(expectedGate)) {
    failures.push(`${label}: caught by ${failed.join(',')} but NOT by ${expectedGate}`);
    return;
  }
  pass++;
}

// The exemption must admit the real thing...
const withToll = clone(rows);
withToll[0].toll = { status_402: true, headers: ['crawler-price'] };
withToll[0].outcome = 'toll';
ok(validate(withToll, OPTS).ok, 'EXEMPTION CONTROL: a legitimate toll.headers name list is publishable');

// ...and nothing else. A header MAP at the exempt path carries values, which is
// the thing the invariant exists to forbid.
corrupt('a header map smuggled in at the exempt path', 'toll_header_shape', (r) => {
  r[0].toll = { status_402: false, headers: { 'crawler-price': '0.01' } };
  return r;
});

corrupt('an unallowlisted header name recorded', 'toll_header_shape', (r) => {
  r[0].toll = { status_402: false, headers: ['set-cookie'] };
  return r;
});

corrupt('a response header map anywhere else', 'privacy_shape', (r) => {
  r[0].headers = { server: 'nginx' };
  return r;
});

corrupt('a header map nested under robots', 'privacy_shape', (r) => {
  r[0].robots.headers = { 'x-robots-tag': 'noai' };
  return r;
});

corrupt('a stored user-agent string', 'privacy_shape', (r) => {
  r[0].ua = 'CanIReachBot/0.1';
  return r;
});

corrupt('a domain missing from the run', 'domain_coverage', (r) => r.filter((x) => x.domain !== 'c.example'));

corrupt('a domain that stalled part-way', 'rows_per_domain', (r) => {
  const i = r.findIndex((x) => x.domain === 'b.example' && x.kind === 'file');
  r.splice(i, 1);
  return r;
});

// Renamed rather than removed, so row counts stay intact and only the dialect
// gate can catch it.
corrupt('a dialect silently renamed', 'dialect_coverage', (r) => {
  for (const x of r) if (x.dialect === 'claudebot') x.dialect = 'claudebot-v2';
  return r;
});

corrupt('two runs appended to one file', 'run_consistency', (r) => {
  for (const x of r) if (x.domain === 'e.example') x.run = '2026-08-23';
  return r;
});

corrupt('two vantages merged into one capture', 'vantage_consistency', (r) => {
  for (const x of r) x.vantage = x.domain === 'e.example' ? 'github-actions' : 'local-residential';
  return r;
});

// A capture from before the vantage field existed must still validate: the gate
// forbids MIXING vantages, not omitting one.
const legacy = clone(rows);
ok(validate(legacy, OPTS).ok, 'LEGACY CONTROL: a capture with no vantage field is still publishable');

const tagged = clone(rows).map((x) => ({ ...x, vantage: 'local-residential' }));
ok(validate(tagged, OPTS).ok, 'VANTAGE CONTROL: a uniformly tagged capture is publishable');

corrupt('an outcome outside the published enum', 'known_outcomes', (r) => {
  r.find((x) => x.kind === 'request').outcome = 'mystery';
  return r;
});

corrupt('our own network down, so the web looks blocked', 'instrument_health', (r) => {
  for (const x of r) if (x.kind === 'request' && x.outcome === 'reachable') x.outcome = 'error';
  return r;
});

// The floor is a threshold, so it needs the boundary tested from both sides:
// a bad night that is still a real measurement must NOT be rejected.
const partial = clone(rows);
let flipped = 0;
for (const x of partial) {
  if (x.kind === 'request' && x.outcome === 'reachable' && flipped < 10) {
    x.outcome = 'blocked';
    flipped++;
  }
}
const partialStats = aggregate(partial);
const partialRate = partialStats.outcomes.reachable / partialStats.requests_sent;
ok(partialRate > REACHABLE_FLOOR, 'boundary fixture sits above the floor by construction');
ok(validate(partial, OPTS).ok, 'a heavily blocked but real night is still publishable');

// --- report -----------------------------------------------------------------

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log('capture gates verified: every gate demonstrated failing on its own corruption.');
