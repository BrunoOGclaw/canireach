// Tests for the derived aggregates.
//
// Every expectation below is a value hand-counted from the fixture, not a second
// call to the function under test. An aggregate suite that compares aggregate()
// against aggregate() is the purest form of a test that cannot fail.
//
// The fixture is deliberately lopsided — one domain per interesting state — so
// that a plausible-but-wrong implementation (counting request rows instead of
// sent requests, adding robots denials to blocks, reading the v2 toll field only)
// produces a different number and is caught.
//
// Run: node tools/test-aggregate.mjs

import { aggregate } from './aggregate.mjs';

let pass = 0;
const failures = [];

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else failures.push(`${label}\n     expected ${e}\n     actual   ${a}`);
}

const DIALECTS = ['browser', 'curl', 'canireach', 'gptbot', 'claudebot'];

function requestRow(domain, dialect, extra) {
  return { schema_version: 2, run: 'r', vantage: 'v', domain, kind: 'request', dialect, ...extra };
}

// 5 domains x 5 dialects. Each domain is one state:
//   ok.example        reachable, nginx
//   blocked.example   403 behind Cloudflare, challenged
//   denied.example    robots says no, so nothing is sent
//   unknown.example   robots policy unknown, fail-closed, nothing sent
//   toll.example      402 with a price header
const rows = [];
for (const d of DIALECTS) {
  rows.push(requestRow('ok.example', d, { robots: { allowed: true }, requested: true, status: 200, outcome: 'reachable', server: 'nginx/1.24' }));
  rows.push(
    requestRow('blocked.example', d, {
      robots: { allowed: true },
      requested: true,
      status: 403,
      outcome: 'challenged',
      challenge: 'cloudflare-challenge',
      server: 'cloudflare',
      redirected: true,
      redirect_cross_origin: true,
    }),
  );
  rows.push(requestRow('denied.example', d, { robots: { allowed: false, reason: 'disallow-rule' }, requested: false, outcome: 'denied_by_robots' }));
  rows.push(
    requestRow('unknown.example', d, {
      robots: { allowed: false, reason: 'robots-policy-unknown-http-503' },
      requested: false,
      outcome: 'denied_by_robots',
    }),
  );
  rows.push(
    requestRow('toll.example', d, {
      robots: { allowed: true },
      requested: true,
      status: 402,
      outcome: 'toll',
      toll: { status_402: true, header_names: ['crawler-price'] },
      server: 'nginx/1.24',
    }),
  );
}
// File rows: llms.txt present on one domain, a soft-404 on another, and not
// checked at all on the robots-denied one.
for (const domain of ['ok.example', 'blocked.example', 'denied.example', 'unknown.example', 'toll.example']) {
  rows.push({ schema_version: 2, vantage: 'v', domain, kind: 'file', file: 'robots', status: domain === 'unknown.example' ? 503 : 200 });
  rows.push({
    schema_version: 2,
    vantage: 'v',
    domain,
    kind: 'file',
    file: 'llms_txt',
    ...(domain === 'ok.example'
      ? { status: 200, present: true, soft_404: false }
      : domain === 'blocked.example'
        ? { status: 200, present: false, soft_404: true }
        : domain === 'denied.example'
          ? { status: null, present: false, soft_404: false, outcome: 'denied_by_robots' }
          : { status: 404, present: false, soft_404: false }),
  });
}

const a = aggregate(rows);

eq(a.request_rows, 25, 'request rows');
eq(a.file_rows, 10, 'file rows');
eq(a.domains, 5, 'distinct domains');

// 3 of 5 domains are actually contacted; the two robots states send nothing.
eq(a.requests_sent, 15, 'sent excludes both robots-denied and policy-unknown');
eq(a.outcomes, { reachable: 5, challenged: 5, denied_by_robots: 10, toll: 5 }, 'outcome counts');

// 5 reachable / 15 sent. Over all 25 request rows it would be 0.2, which is the
// wrong answer and the reason this denominator is named in the output.
eq(a.reachable_rate_of_sent, 0.3333, 'reachable rate is over SENT requests');

eq(a.by_dialect.canireach, { attempted: 5, sent: 3, outcomes: { reachable: 1, challenged: 1, denied_by_robots: 2, toll: 1 } }, 'per-dialect split');

// The two robots states are NOT the same fact and must not be merged: one is a
// site that said no, the other is a site whose policy we could not read.
eq(a.robots_policy.gptbot, { allowed: 3, denied: 1, unknown: 1 }, 'denied and policy-unknown are counted apart');

eq(a.challenges, { 'cloudflare-challenge': 5 }, 'challenge vendors');
eq(a.toll, { status_402: 5, 'crawler-price': 5 }, 'toll signals by kind');
eq(a.top_servers, { nginx: 10, cloudflare: 5 }, 'server distribution');
eq(a.redirects, { observed: 5, cross_origin: 5 }, 'redirects observed but never followed');
eq(a.robots_txt, { served_200: 4, absent_or_error: 1 }, 'robots.txt availability');
eq(a.affordances.llms_txt, { checked: 5, present: 1, soft_404: 1, not_checked: 1 }, 'affordance adoption, soft-404s kept separate from presence');
eq(a.vantages, ['v'], 'vantages listed');
eq(a.schema_versions, [2], 'schema versions listed');

// --- v1 compatibility -------------------------------------------------------
// The published pre-September-15 baseline is immutable v1. If the aggregator
// cannot read it, the whole before/after comparison is impossible, so this is
// load-bearing rather than politeness to old data.

const v1 = [
  { run: 'r', domain: 'a.example', kind: 'request', dialect: 'curl', robots: { allowed: true }, requested: true, outcome: 'toll', toll: { status_402: false, headers: ['x-payment'] } },
];
const av1 = aggregate(v1);
eq(av1.toll, { 'x-payment': 1 }, 'v1 toll.headers is read as header names');
eq(av1.schema_versions, [1], 'a capture with no schema_version is v1');
eq(av1.vantages, ['unrecorded'], 'a v1 capture reports its vantage as unrecorded, not guessed');

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log('aggregates verified against hand-counted fixtures, v1 and v2.');
