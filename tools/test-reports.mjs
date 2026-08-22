// Tests for the crowd-report envelope and the quarantine state machine.
//
// Every expectation is hand-reasoned from the fixture. Nothing here calls the
// function under test to compute its own expected value.
//
// The suite is organised around the ways this module is supposed to REFUSE,
// because that is the entire reason it exists. A test file that only proves
// well-formed reports are accepted would pass just as happily against a module
// that accepted everything.
//
// Run: node tools/test-reports.mjs

import { classifyOutcome } from './probe.mjs';
import { DIALECTS } from './dialects.mjs';
import {
  DIALECT_CLASSES,
  DIALECT_TO_CLASS,
  dialectClassMap,
  ENVELOPE,
  FORBIDDEN_FIELD_NAMES,
  MIN_INDEPENDENT_REPORTERS,
  OUTCOMES,
  PROBE_MATCH_MAX_LAG_MINUTES,
  RATE_LIMITS,
  abuseFindings,
  assertEnvelopeCarriesNoForbiddenField,
  claimKey,
  probeEvidenceFromCapture,
  reportCounts,
  resolve,
  submissionKey,
  validateReport,
  windowBucket,
} from './reports.mjs';

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
function throws(fn, label) {
  try {
    fn();
    failures.push(`${label} (expected a throw, got none)`);
  } catch {
    pass++;
  }
}

// --- fixtures ---------------------------------------------------------------

const RECEIVED = '2026-08-22T12:10:00.000Z';

function report(over = {}) {
  return {
    schema_version: 1,
    report_id: 'r-1',
    domain: 'example.com',
    observed_at: '2026-08-22T12:05:00.000Z',
    dialect_class: 'self-identified-agent',
    outcome: 'blocked',
    evidence_class: 'observed_status',
    vantage_class: 'residential',
    status: 403,
    reporter: { identity_class: 'anonymous' },
    ...over,
  };
}
const signer = (thumb) => ({ identity_class: 'web_bot_auth', key_thumbprint: thumb });
const entry = (r, received = RECEIVED) => ({ report: r, received_at: received });

// --- 1. the outcome vocabulary is DERIVED from the running probe ------------
//
// Sweep every status the classifier can be handed, plus the challenge and toll
// branches, and collect what it actually returns. If probe.mjs learns a new
// outcome, this fails here rather than silently making that outcome unreportable.

const derived = new Set();
for (let status = 100; status <= 599; status++) derived.add(classifyOutcome(status, null, null));
derived.add(classifyOutcome(200, 'cloudflare', null));
derived.add(classifyOutcome(200, null, { status_402: true }));
derived.add(classifyOutcome(0, null, null)); // the `other` floor
// Written by probe.mjs directly rather than by the classifier.
derived.add('denied_by_robots');
derived.add('error');

const missing = [...derived].filter((o) => !OUTCOMES.includes(o)).sort();
eq(missing, [], 'OUTCOMES covers every outcome the probe can produce');
ok(derived.has('reachable') && derived.has('blocked') && derived.size >= 10, 'the sweep actually exercised the classifier');

// --- 2. the envelope allowlist ----------------------------------------------

ok(validateReport(report(), RECEIVED).valid, 'a well-formed report validates');

eq(
  validateReport({ ...report(), body: '<html>' }, RECEIVED).errors,
  ['body: unknown field'],
  'page content is rejected, not stripped',
);
eq(
  validateReport({ ...report(), reporter: { identity_class: 'anonymous', ip: '1.2.3.4' } }, RECEIVED).errors,
  ['reporter.ip: unknown field'],
  'unknown nested fields are rejected too',
);
ok(!validateReport({ ...report(), domain: 'https://example.com/x?t=secret' }, RECEIVED).valid, 'a URL is not a hostname');
ok(!validateReport({ ...report(), domain: 'example.com:443' }, RECEIVED).valid, 'a port is not part of a hostname');
ok(!validateReport({ ...report(), domain: 'localhost' }, RECEIVED).valid, 'a bare label is not a hostname');
ok(!validateReport({ ...report(), outcome: 'totally_blocked' }, RECEIVED).valid, 'an invented outcome is rejected');
ok(!validateReport({ ...report(), schema_version: 2 }, RECEIVED).valid, 'a future schema version is rejected');
ok(!validateReport({ ...report(), status: 999 }, RECEIVED).valid, 'a non-HTTP status is rejected');
ok(!validateReport({ ...report(), observed_at: 'yesterday' }, RECEIVED).valid, 'an unparseable timestamp is rejected');
eq(validateReport(report({ report_id: undefined }), RECEIVED).errors, ['report_id: missing'], 'required fields are required');

// The allowlist is the mechanism, so the allowlist itself is guarded.
ok(assertEnvelopeCarriesNoForbiddenField(), 'the shipped envelope carries no forbidden field');
throws(
  () => assertEnvelopeCarriesNoForbiddenField({ ...ENVELOPE, headers: { type: 'object', fields: {} } }),
  'widening the envelope to a forbidden field throws',
);
throws(
  () =>
    assertEnvelopeCarriesNoForbiddenField({
      ...ENVELOPE,
      reporter: { type: 'object', fields: { email: { type: 'token' } } },
    }),
  'a forbidden field nested one level deep also throws',
);
// Whole-name matching, not substring: `key_thumbprint` is a hash of a PUBLIC key.
ok(FORBIDDEN_FIELD_NAMES.includes('key'), 'the forbidden list does contain the word it must not substring-match');
ok(assertEnvelopeCarriesNoForbiddenField(), 'key_thumbprint survives a list containing "key"');

// --- 3. identity binding ----------------------------------------------------

ok(validateReport(report({ reporter: signer('t-a') }), RECEIVED).valid, 'a signed reporter validates');
eq(
  validateReport(report({ reporter: { identity_class: 'web_bot_auth' } }), RECEIVED).errors,
  ['reporter.key_thumbprint: required for a verified identity class'],
  'a verified class without a thumbprint is rejected',
);
eq(
  validateReport(report({ reporter: { identity_class: 'self_declared', key_thumbprint: 't-x' } }), RECEIVED).errors,
  ['reporter.key_thumbprint: present on an unverified identity class'],
  'an unverified class carrying a thumbprint is rejected, not silently ignored',
);

// --- 4. timestamps the reporter chose ---------------------------------------

ok(
  !validateReport(report({ observed_at: '2026-08-22T13:00:00.000Z' }), RECEIVED).valid,
  'an observation from the future is rejected',
);
ok(
  validateReport(report({ observed_at: '2026-08-22T12:13:00.000Z' }), RECEIVED).valid,
  'three minutes of clock skew is tolerated',
);

// --- 5. the two keys are not the same key -----------------------------------

const a = report({ report_id: 'r-9', reporter: signer('t-a') });
const b = report({ report_id: 'r-9', reporter: signer('t-b') });
ok(submissionKey(a) !== submissionKey(b), 'the same report_id from two reporters is two submissions');
eq(claimKey(a), claimKey(b), 'those two submissions are the same claim');
ok(
  claimKey(report({ outcome: 'reachable' })) !== claimKey(report({ outcome: 'blocked' })),
  'a different outcome is a different claim, so disagreement cannot average out',
);
eq(windowBucket('2026-08-22T12:59:59.000Z'), '2026-08-22T12:00:00Z', 'the window bucket floors to the hour');
ok(
  claimKey(report({ observed_at: '2026-08-22T12:05:00.000Z' })) !==
    claimKey(report({ observed_at: '2026-08-22T13:05:00.000Z' })),
  'an hour later is a different claim',
);

// --- 6. quarantine is the default and retries do not escape it --------------

const oneReport = resolve([entry(report({ reporter: signer('t-a') }))], { now: RECEIVED });
eq(oneReport.claims[0].state, 'quarantined', 'a single signed report stays quarantined');
eq(oneReport.claims[0].distinct_verified_identities, 1, 'one signed reporter is one identity');

// THE CENTRAL TEST. Four submissions, one reporter, four different report_ids —
// the cheapest possible attempt to look like a crowd.
const spam = [1, 2, 3, 4].map((i) => entry(report({ report_id: `r-${i}`, reporter: signer('t-a') })));
const spamRes = resolve(spam, { now: RECEIVED });
eq(spamRes.claims.length, 1, 'four submissions about one thing are one claim');
eq(spamRes.claims[0].distinct_verified_identities, 1, 'four submissions from one key are one identity');
eq(spamRes.claims[0].state, 'quarantined', 'a single reporter cannot promote itself by volume');

// The same report submitted twice is one submission.
const retries = [entry(report({ reporter: signer('t-a') })), entry(report({ reporter: signer('t-a') }), '2026-08-22T12:11:00.000Z')];
const retryRes = resolve(retries, { now: RECEIVED });
eq(retryRes.duplicate_submissions, 1, 'the exact resubmission is counted as a duplicate');
eq(retryRes.claims[0].submissions, 1, 'and it does not become a second voice');

// --- 7. promotion by independent verified reporters -------------------------

const twoSigners = [
  entry(report({ report_id: 'r-1', reporter: signer('t-a') })),
  entry(report({ report_id: 'r-2', reporter: signer('t-b') })),
];
const promoted = resolve(twoSigners, { now: RECEIVED });
eq(promoted.claims[0].state, 'corroborated', 'two distinct verified identities promote a claim');
eq(promoted.claims[0].promotion_reasons, ['independent_verified_reporters'], 'and say why');
eq(MIN_INDEPENDENT_REPORTERS, 2, 'the threshold is the one the tests assume');

// Free identities are worth zero, however many of them there are.
const manyUnsigned = ['a', 'b', 'c', 'd', 'e', 'f'].map((i) =>
  entry(report({ report_id: `r-${i}`, reporter: { identity_class: 'self_declared' } })),
);
const unsignedRes = resolve(manyUnsigned, { now: RECEIVED });
eq(unsignedRes.claims[0].submissions, 6, 'six self-declared reporters were accepted');
eq(unsignedRes.claims[0].distinct_verified_identities, 0, 'and count zero toward independence');
eq(unsignedRes.claims[0].state, 'quarantined', 'so they cannot promote a claim by agreeing');

// Assertions are unpromotable no matter who signs them.
const assertions = [
  entry(report({ report_id: 'r-1', evidence_class: 'assertion', reporter: signer('t-a') })),
  entry(report({ report_id: 'r-2', evidence_class: 'assertion', reporter: signer('t-b') })),
];
eq(resolve(assertions, { now: RECEIVED }).claims[0].state, 'quarantined', 'two signed assertions still do not promote');

// --- 8. promotion by an owned probe match -----------------------------------

const manifest = {
  capture_id: 'cap-1',
  observed_from: '2026-08-22T12:00:00.000Z',
  vantage: { class: 'github-hosted-dynamic-egress' },
};
const captureRows = [
  { kind: 'request', domain: 'example.com', dialect: 'canireach', outcome: 'blocked', ts: '2026-08-22T12:00:00.000Z' },
  { kind: 'request', domain: 'other.com', dialect: 'browser', outcome: 'reachable', ts: '2026-08-22T12:00:00.000Z' },
  { kind: 'file', domain: 'example.com', file: 'robots', outcome: 'reachable' },
];
const evidence = probeEvidenceFromCapture(manifest, captureRows);
eq(evidence.length, 2, 'only request rows become probe evidence');
eq(evidence[0].dialect_class, 'self-identified-agent', 'probe dialect ids map to reporter dialect classes');

// Every dialect the probe can present must map to a real reporter class. An
// unmapped one would become `unrecorded`, which never equals anything, and its
// capture rows would silently lose the ability to corroborate anything at all.
eq(
  DIALECTS.map((d) => d.id).filter((id) => !DIALECT_CLASSES.includes(DIALECT_TO_CLASS[id])),
  [],
  'every probe dialect maps to a declared reporter class',
);
eq(Object.keys(DIALECT_TO_CLASS).sort(), DIALECTS.map((d) => d.id).sort(), 'the mapping covers the registry exactly');

// The guard that matters is unreachable from the registry we ship — every kind
// in dialects.mjs is mapped, so nothing real can exercise the refusal. Hand it
// the state that should never exist, which is the only thing that holds it.
throws(
  () => dialectClassMap([{ id: 'future-agent', kind: 'a-kind-nobody-has-mapped' }]),
  'an unmapped dialect kind throws rather than becoming unrecorded',
);
throws(
  () => dialectClassMap([{ id: 'x', kind: 'human-baseline' }, { id: 'y', kind: 'signed-but-unmapped' }]),
  'one unmapped kind among valid ones still throws',
);
ok(Object.keys(dialectClassMap(DIALECTS)).length === DIALECTS.length, 'and the real registry still derives cleanly');

const matched = resolve([entry(report({ reporter: { identity_class: 'anonymous' } }))], {
  probeEvidence: evidence,
  now: RECEIVED,
});
eq(matched.claims[0].state, 'corroborated', 'an owned probe match promotes even an anonymous report');
eq(matched.claims[0].promotion_reasons, ['owned_probe_match'], 'and names the reason');
eq(matched.claims[0].probe_match.capture_id, 'cap-1', 'and records which capture did it');

// Disagreement on any of the three fields is not a match.
eq(
  resolve([entry(report({ outcome: 'reachable' }))], { probeEvidence: evidence, now: RECEIVED }).claims[0].state,
  'quarantined',
  'a probe that saw a different outcome does not corroborate',
);
eq(
  resolve([entry(report({ dialect_class: 'human-baseline' }))], { probeEvidence: evidence, now: RECEIVED }).claims[0].state,
  'quarantined',
  'a probe of a different identity does not corroborate',
);
eq(
  resolve([entry(report({ domain: 'elsewhere.com' }))], { probeEvidence: evidence, now: RECEIVED }).claims[0].state,
  'quarantined',
  'a probe of a different domain does not corroborate',
);

// THE LAG BOUND. Same door, same outcome, fourteen hours apart — the exact
// pairing tools/compare.mjs was taught to refuse one layer up.
const stale = entry(
  report({ observed_at: '2026-08-22T02:00:00.000Z' }),
  '2026-08-22T02:05:00.000Z',
);
eq(
  resolve([stale], { probeEvidence: evidence, now: RECEIVED }).claims[0].state,
  'quarantined',
  'a probe ten hours away is a coincidence of the clock, not corroboration',
);
// ...and the bound is not vacuously large: just inside it, the same pair matches.
const insideLag = entry(
  report({ observed_at: '2026-08-22T09:30:00.000Z' }),
  '2026-08-22T09:35:00.000Z',
);
eq(
  resolve([insideLag], { probeEvidence: evidence, now: RECEIVED }).claims[0].state,
  'corroborated',
  'two and a half hours away is inside the bound and does corroborate',
);
eq(PROBE_MATCH_MAX_LAG_MINUTES, 180, 'the lag bound is the one the tests bracket');

// --- 9. contested ------------------------------------------------------------

const conflict = [
  entry(report({ report_id: 'r-1', outcome: 'blocked', reporter: signer('t-a') })),
  entry(report({ report_id: 'r-2', outcome: 'blocked', reporter: signer('t-b') })),
  entry(report({ report_id: 'r-3', outcome: 'reachable', reporter: signer('t-c') })),
  entry(report({ report_id: 'r-4', outcome: 'reachable', reporter: signer('t-d') })),
];
const contested = resolve(conflict, { now: RECEIVED });
eq(contested.claims.length, 2, 'two outcomes are two claims');
eq(
  contested.claims.map((c) => c.state).sort(),
  ['contested', 'contested'],
  'two promoted claims about the same door demote each other',
);
ok(contested.claims.every((c) => c.contested_with.length === 1), 'and each names what it conflicts with');

// A conflict where only one side has standing is NOT contested: the quarantined
// side never had a claim on the record to begin with.
const oneSided = [
  entry(report({ report_id: 'r-1', outcome: 'blocked', reporter: signer('t-a') })),
  entry(report({ report_id: 'r-2', outcome: 'blocked', reporter: signer('t-b') })),
  entry(report({ report_id: 'r-3', outcome: 'reachable', reporter: { identity_class: 'anonymous' } })),
];
const oneSidedRes = resolve(oneSided, { now: RECEIVED });
eq(
  oneSidedRes.claims.map((c) => `${c.outcome}:${c.state}`).sort(),
  ['blocked:corroborated', 'reachable:quarantined'],
  'an unpromoted dissent does not demote a corroborated claim',
);

// --- 10. retention and stale reports ----------------------------------------

const old = entry(report({ reporter: signer('t-a') }), '2026-01-01T00:00:00.000Z');
eq(resolve([old], { now: RECEIVED }).claims[0].state, 'expired', 'a report past retention expires');

// Received promptly but describing something two weeks old: retained, and unable
// to corroborate, because nothing can still speak to that moment.
const ancient = [
  entry(report({ report_id: 'r-1', observed_at: '2026-08-01T12:05:00.000Z' }), '2026-08-22T12:05:00.000Z'),
  entry(
    report({ report_id: 'r-2', observed_at: '2026-08-01T12:05:00.000Z', reporter: signer('t-a') }),
    '2026-08-22T12:05:00.000Z',
  ),
  entry(
    report({ report_id: 'r-3', observed_at: '2026-08-01T12:05:00.000Z', reporter: signer('t-b') }),
    '2026-08-22T12:05:00.000Z',
  ),
];
const ancientRes = resolve(ancient, { now: RECEIVED });
eq(ancientRes.claims[0].submissions, 3, 'a very late report is retained');
eq(ancientRes.claims[0].eligible, 0, 'but is not eligible to corroborate');
eq(ancientRes.claims[0].state, 'quarantined', 'so two signed late reports do not promote');

// --- 11. the counts are kept apart ------------------------------------------

const mixed = resolve(
  [
    entry(report({ report_id: 'r-1', reporter: signer('t-a') })),
    entry(report({ report_id: 'r-2', reporter: signer('t-b') })),
    entry(report({ report_id: 'r-2', reporter: signer('t-b') })), // exact retry
    entry(report({ report_id: 'r-3', domain: 'lonely.com', reporter: signer('t-a') })),
  ],
  { now: RECEIVED },
);
const counts = reportCounts(mixed);
eq(counts.submissions, 4, 'raw submissions include the retry');
eq(counts.distinct_submissions, 3, 'distinct submissions do not');
eq(counts.claims, 2, 'they form two claims');
eq(counts.corroborated_claims, 1, 'only one of which is corroborated');
eq(counts.quarantined_claims, 1, 'the other is quarantined');
// t-a filed about two domains; unioning must not report it twice.
eq(counts.distinct_verified_identities, 2, 'identities are unioned across claims, never summed');

// --- 12. abuse ceilings ------------------------------------------------------

const flood = Array.from({ length: RATE_LIMITS.anonymous + 1 }, (_, i) =>
  entry(report({ report_id: `r-${i}`, reporter: { identity_class: 'anonymous' } })),
);
const findings = abuseFindings(flood, { now: RECEIVED });
eq(findings.length, 1, 'an anonymous flood is flagged');
eq(findings[0].limit, RATE_LIMITS.anonymous, 'against the anonymous ceiling');
eq(abuseFindings(flood.slice(0, RATE_LIMITS.anonymous), { now: RECEIVED }), [], 'exactly at the ceiling is not flagged');
// Yesterday's traffic is outside the rolling day.
eq(
  abuseFindings(
    flood.map((e) => ({ ...e, received_at: '2026-08-20T12:00:00.000Z' })),
    { now: RECEIVED },
  ),
  [],
  'the ceiling is a rolling day, not all of history',
);

// --- 13. reproducibility -----------------------------------------------------

throws(() => resolve([], {}), 'resolve() refuses to invent a clock');
throws(() => abuseFindings([], {}), 'abuseFindings() refuses to invent a clock');
eq(
  JSON.stringify(resolve(conflict, { now: RECEIVED })),
  JSON.stringify(resolve([...conflict].reverse(), { now: RECEIVED })),
  'the resolution does not depend on ledger order',
);

// --- report ------------------------------------------------------------------

if (failures.length) {
  console.error(`FAIL ${failures.length} of ${pass + failures.length}`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`ok  ${pass} assertions (crowd-report envelope + quarantine state machine)`);
