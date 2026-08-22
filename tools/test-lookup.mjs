// Tests for the traveler's answer engine.
//
// Every expectation is hand-reasoned from the fixture. Nothing here calls the
// function under test to compute its own expected value.
//
// The suite is organised around the ways this module must REFUSE TO ANSWER,
// because that is where a reachability tool does its damage. A suite that only
// checked "example.com came back blocked" would pass against a module that
// reported every unread robots.txt as a block — which is 4,055 of the 5,000
// request rows in the current capture, and would be this project telling agents
// the web is shut on the strength of its own fail-closed default.
//
// Run: node tools/test-lookup.mjs

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DIALECTS, SITE_FILES } from './dialects.mjs';
import { DIALECT_TO_CLASS, PROBE_MATCH_MAX_LAG_MINUTES, resolve } from './reports.mjs';
import {
  EVIDENCE_KINDS,
  PRESENT_TENSE_FIELD_NAMES,
  assertNoPresentTenseField,
  buildIndex,
  comparabilityProfile,
  crowdBlock,
  datasetStatus,
  lookup,
  normalizeDomain,
  robotsUnavailableBehaviour,
} from './lookup.mjs';
import { COMPARABILITY_DIMENSIONS, UNRECORDED } from './policy.mjs';

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

const HERE = new URL('.', import.meta.url).pathname;

// --- fixtures ---------------------------------------------------------------

const OBSERVED_FROM = '2026-08-22T09:17:00.000Z';
const OBSERVED_THROUGH = '2026-08-22T09:19:00.000Z';

const MANIFEST = {
  schema_version: 3,
  capture_id: '2026-08-22T0917Z-slot0417-gh1a1',
  scheduled_slot: '2026-08-23T04:17',
  observation_window: { slot: '04:17[America/Chicago]', nominal: '04:17', observed_local: '04:19', drift_minutes: 2 },
  observed_from: OBSERVED_FROM,
  observed_through: OBSERVED_THROUGH,
  vantage: { id: 'github-actions-ubuntu-dynamic', class: 'github-hosted-dynamic-egress' },
  instrument_policy: { profile_version: 1, robots_unavailable: 'fail-closed-except-404-410' },
  dataset: { sha256: 'a'.repeat(64), rows: 0 },
};

const base = { schema_version: 2, ts: OBSERVED_FROM, run: MANIFEST.capture_id, vantage: 'github-actions-ubuntu-dynamic' };

/** A door we knocked on: robots read, allowed, request sent. */
function reached(domain, dialect, over = {}) {
  return {
    ...base,
    domain,
    kind: 'request',
    dialect,
    robots: { allowed: true, reason: 'no-matching-rule', rule: null, group: null, explicit: false, known: true },
    requested: true,
    outcome: 'reachable',
    status: 200,
    ...over,
  };
}

/** The site's own declaration: robots.txt READ, and it says no to this token. */
function robotsSaidNo(domain, dialect) {
  return {
    ...base,
    domain,
    kind: 'request',
    dialect,
    robots: {
      allowed: false,
      reason: 'disallow-rule',
      rule: '/',
      group: 'GPTBot',
      explicit: true,
      known: true,
    },
    requested: false,
    outcome: 'denied_by_robots',
  };
}

/** Our instrument's fail-closed default: robots.txt UNREADABLE. Says nothing about the host. */
function neverAsked(domain, dialect) {
  return {
    ...base,
    domain,
    kind: 'request',
    dialect,
    robots: {
      allowed: false,
      reason: 'robots-policy-unknown-http-301',
      rule: null,
      group: null,
      explicit: false,
      known: false,
    },
    requested: false,
    outcome: 'denied_by_robots',
  };
}

function fileRow(domain, file, over = {}) {
  return { ...base, domain, kind: 'file', file, status: 200, present: true, soft_404: false, ...over };
}

const ROWS = [
  // open.example — every door knocked on, one of them tolled, affordances published.
  ...DIALECTS.map((d) => reached('open.example', d.id)),
  fileRow('open.example', 'robots', { present: undefined, redirected: false }),
  fileRow('open.example', 'llms_txt'),
  fileRow('open.example', 'agents_md', { status: 404, present: false }),
  fileRow('open.example', 'wellknown_agents', { status: 404, present: false }),
  fileRow('open.example', 'web_bot_auth'),

  // declared.example — robots.txt READ and it disallows gptbot by name.
  robotsSaidNo('declared.example', 'gptbot'),
  reached('declared.example', 'browser'),
  fileRow('declared.example', 'robots', { present: undefined }),
  fileRow('declared.example', 'llms_txt', { status: 404, present: false }),

  // unreadable.example — robots.txt 301'd. We asked NOTHING. The trap.
  ...DIALECTS.map((d) => neverAsked('unreadable.example', d.id)),
  fileRow('unreadable.example', 'robots', { status: 301, present: undefined, redirected: true }),
  ...SITE_FILES.filter((f) => f.id !== 'robots').map((f) =>
    fileRow('unreadable.example', f.id, { status: null, present: false, outcome: 'denied_by_robots' }),
  ),
];

// A toll on one door of open.example, so the detour has a price in it.
ROWS.push(
  reached('tolled.example', 'canireach', {
    outcome: 'toll',
    status: 402,
    toll: { status_402: true, header_names: ['x-payment-required'] },
  }),
);

const INDEX = buildIndex({ manifest: MANIFEST, rows: ROWS, dialectClasses: DIALECT_TO_CLASS });

// One hour after the capture ended: inside the bound.
const NOW_FRESH = '2026-08-22T10:19:00.000Z';
// Twelve hours after: the exact failure the card names.
const NOW_STALE = '2026-08-22T21:19:00.000Z';

// --- 1. the not-attempted trap ----------------------------------------------
// The single most consequential distinction in this module. Both rows below
// carry `outcome: 'denied_by_robots'`; only one is about the host.

const unreadable = lookup(INDEX, 'unreadable.example', { now: NOW_FRESH });
const declared = lookup(INDEX, 'declared.example', { now: NOW_FRESH });

eq(
  unreadable.doors.map((d) => d.evidence).sort(),
  ['not-attempted', 'not-attempted', 'not-attempted', 'not-attempted', 'not-attempted'],
  'an unreadable robots.txt makes every door not-attempted, not denied',
);
eq(
  unreadable.doors.every((d) => d.last_outcome === null),
  true,
  'a door we never knocked on carries NO outcome',
);
eq(
  unreadable.doors[0].robots.declared,
  'unreadable',
  "our fail-closed default is reported as the policy being unreadable, not as the site's 'no'",
);
eq(
  unreadable.doors[0].robots.reason,
  'robots-policy-unknown-http-301',
  'the reason survives, so a caller can see it was a redirect and not a refusal',
);
ok(
  unreadable.limits.some((l) => l.includes('fact about the instrument')),
  'the answer says out loud that not-attempted is a fact about the instrument',
);
ok(
  unreadable.limits.some((l) => l.includes('No request was sent to this host at any identity')),
  'a host we never once knocked on says so',
);

const gptDoor = declared.doors.find((d) => d.dialect === 'gptbot');
eq(gptDoor.evidence, 'robots-declaration', "a READ robots.txt that says no is the site's declaration");
eq(gptDoor.last_outcome, null, 'even a real robots denial carries no behavioural outcome — we never asked');
eq(gptDoor.robots.declared, 'disallow', 'the declaration is reported as a disallow');
eq(gptDoor.robots.explicit_group, true, 'a group written for this token by name is distinguished from a * catch-all');
eq(
  declared.doors.find((d) => d.dialect === 'browser').evidence,
  'behaviour',
  'the same host can carry a declaration at one door and behaviour at another',
);
ok(
  !declared.limits.some((l) => l.includes('No request was sent to this host at any identity')),
  'a host with one knocked door does not claim nothing was sent',
);

// The two are genuinely different answers, which is the whole point.
ok(
  unreadable.doors[0].evidence !== gptDoor.evidence,
  'the two denial shapes do not collapse into one evidence kind',
);
ok(EVIDENCE_KINDS.length === 3, 'there are exactly three evidence kinds');

// --- 2. behaviour is the only thing that carries an outcome ------------------

const open = lookup(INDEX, 'open.example', { now: NOW_FRESH });
eq(open.doors.length, 5, 'every dialect is a door');
eq(
  open.doors.every((d) => d.evidence === 'behaviour' && d.last_outcome === 'reachable'),
  true,
  'doors we knocked on carry their measured outcome',
);
eq(open.doors[0].http_status, 200, 'the observed status travels with it');
eq(
  open.doors.map((d) => d.dialect),
  ['browser', 'canireach', 'claudebot', 'curl', 'gptbot'],
  'doors are ordered deterministically, not by row arrival',
);
eq(
  open.doors.find((d) => d.dialect === 'gptbot').dialect_class,
  'vendor-token',
  'the dialect class is derived from the registry, not restated',
);
ok(
  open.limits.some((l) => l.includes('disclosed simulations')),
  'every answer discloses that vendor-token doors are simulations',
);

// --- 3. no present-tense field anywhere -------------------------------------
// The card's named failure mode is an answer that is confidently wrong because
// it is twelve hours old. A field called `reachable` is how that gets read.

for (const answer of [open, declared, unreadable, lookup(INDEX, 'never-seen.example', { now: NOW_STALE })]) {
  ok(assertNoPresentTenseField(answer) === answer, `${answer.domain}: answer carries no present-tense field`);
}
ok(PRESENT_TENSE_FIELD_NAMES.includes('allowed'), '`allowed` is forbidden — it is the probe row\'s own field name');
ok(PRESENT_TENSE_FIELD_NAMES.includes('reachable'), '`reachable` is forbidden');
throws(
  () => assertNoPresentTenseField({ doors: [{ reachable: true }] }),
  'the guard actually fires on a nested present-tense field',
);
throws(() => assertNoPresentTenseField({ a: { b: [{ allowed: false }] } }), 'the guard descends through arrays');
ok(assertNoPresentTenseField({ last_outcome: 'reachable' }), 'a VALUE of "reachable" is fine; only keys are policed');

// --- 4. age and freshness ----------------------------------------------------

eq(open.as_of.observed_at, OBSERVED_THROUGH, 'age is measured from when the capture FINISHED');
eq(open.as_of.age_minutes, 60, 'one hour after the capture ended is 60 minutes');
eq(open.as_of.freshness, 'fresh', '60 minutes is inside the bound');
eq(open.as_of.freshness_bound_minutes, PROBE_MATCH_MAX_LAG_MINUTES, 'the bound is the imported constant');

const stale = lookup(INDEX, 'open.example', { now: NOW_STALE });
eq(stale.as_of.age_minutes, 720, 'twelve hours is 720 minutes');
eq(stale.as_of.freshness, 'stale', 'twelve hours is past the bound');
ok(
  stale.limits.some((l) => l.includes('720 minutes old')),
  'a stale answer says how old it is in its own limits, not in a footnote',
);
ok(!open.limits.some((l) => l.includes('minutes old')), 'a fresh answer does not carry the staleness limit');

// The boundary itself, both sides, so the comparison cannot be off by a hair.
const atBound = new Date(Date.parse(OBSERVED_THROUGH) + PROBE_MATCH_MAX_LAG_MINUTES * 60_000).toISOString();
const pastBound = new Date(Date.parse(OBSERVED_THROUGH) + (PROBE_MATCH_MAX_LAG_MINUTES + 1) * 60_000).toISOString();
eq(lookup(INDEX, 'open.example', { now: atBound }).as_of.freshness, 'fresh', 'exactly at the bound is still fresh');
eq(lookup(INDEX, 'open.example', { now: pastBound }).as_of.freshness, 'stale', 'one minute past the bound is stale');

// --- 5. provenance travels with every answer --------------------------------

eq(open.as_of.capture_id, MANIFEST.capture_id, 'the capture id is in the envelope');
eq(open.as_of.observation_slot, '04:17[America/Chicago]', 'the observation slot is in the envelope');
eq(open.as_of.slot_drift_minutes, 2, 'the slip is published beside the slot, not folded into it');
eq(open.as_of.vantage_class, 'github-hosted-dynamic-egress', 'the vantage class is in the envelope');
eq(open.as_of.dataset_sha256, 'a'.repeat(64), 'the dataset hash is in the envelope');
// An unknown answer is still an answer and still has to say where it came from.
const unknown = lookup(INDEX, 'never-seen.example', { now: NOW_FRESH });
eq(unknown.as_of.capture_id, MANIFEST.capture_id, 'even "unknown" carries the provenance of the capture it is unknown in');

// A capture with no repeatable slot reports it, and `unrecorded` is a real value.
const manualIndex = buildIndex({
  manifest: { ...MANIFEST, observation_window: { slot: 'unrecorded', drift_minutes: null } },
  rows: ROWS,
  dialectClasses: DIALECT_TO_CLASS,
});
eq(
  lookup(manualIndex, 'open.example', { now: NOW_FRESH }).as_of.observation_slot,
  'unrecorded',
  'a manual capture reports an unrecorded slot rather than inventing one',
);

// --- 6. unknown is unknown ---------------------------------------------------

eq(unknown.answer, 'unknown', 'a host we never probed is unknown');
eq(unknown.reason, 'never-probed', 'and says why');
eq(unknown.doors, [], 'with no doors');
eq(unknown.detour, null, 'and no detour');
ok(unknown.limits.some((l) => l.includes('parent domain')), 'the refusal to infer is stated in the answer itself');

// The inference that would be most tempting and is most wrong.
eq(
  lookup(INDEX, 'api.open.example', { now: NOW_FRESH }).answer,
  'unknown',
  'a subdomain of a probed host is NOT answered from its parent',
);
throws(() => lookup(INDEX, 'example', { now: NOW_FRESH }), 'a bare label is refused rather than answered "unknown"');
throws(() => normalizeDomain('example'), 'a bare label with no dot is not a hostname');
throws(() => normalizeDomain(''), 'an empty domain is refused');
throws(() => normalizeDomain(null), 'a non-string domain is refused');
throws(() => normalizeDomain('not a host'), 'a string with spaces is refused');

eq(normalizeDomain('OPEN.Example.'), 'open.example', 'case and a trailing dot are normalized');
eq(normalizeDomain('https://open.example/path?q=1'), 'open.example', 'a URL is reduced to its host');
eq(
  lookup(INDEX, 'https://OPEN.example/deep/path', { now: NOW_FRESH }).answer,
  'measured',
  'and the normalized host finds the same rows',
);

// --- 7. the detour -----------------------------------------------------------

eq(open.detour.affordances.llms_txt, 'present', 'a published llms.txt is present');
eq(open.detour.affordances.agents_md, 'absent', 'a 404 agents.md is absent');
eq(open.detour.affordances.web_bot_auth, 'present', 'a Web Bot Auth directory is present');
eq(open.detour.robots_txt.http_status, 200, 'the robots.txt status is part of the detour');

// The same trap as the doors, one layer over: a file we never fetched is not absent.
eq(
  unreadable.detour.affordances.llms_txt,
  'unknown',
  'a file we skipped because the robots gate closed is UNKNOWN, never absent',
);
eq(
  Object.values(unreadable.detour.affordances).every((v) => v === 'unknown'),
  true,
  'and that holds for every affordance on such a host',
);
eq(unreadable.detour.robots_txt.redirected, true, 'the redirect that made robots unreadable is visible');

// A soft 404 is a 200 that means nothing, and is not counted as a real file.
const softIndex = buildIndex({
  manifest: MANIFEST,
  rows: [reached('soft.example', 'browser'), fileRow('soft.example', 'llms_txt', { soft_404: true })],
  dialectClasses: DIALECT_TO_CLASS,
});
eq(
  lookup(softIndex, 'soft.example', { now: NOW_FRESH }).detour.affordances.llms_txt,
  'present-but-soft-404',
  'a soft 404 is named rather than counted as a published affordance',
);

// The price, where there is one.
const tolled = lookup(INDEX, 'tolled.example', { now: NOW_FRESH });
eq(tolled.detour.toll, { status_402_observed: true, header_names: ['x-payment-required'] }, 'the toll is the price in the detour');
eq(open.detour.toll, null, 'a host with no toll reports no toll rather than an empty shape');

// --- 8. crowd claims are never served as fact -------------------------------

const REPORT_AT = '2026-08-22T09:18:00.000Z';
function ledgerEntry(id, over = {}) {
  return {
    received_at: '2026-08-22T09:30:00.000Z',
    report: {
      schema_version: 1,
      report_id: id,
      domain: 'open.example',
      observed_at: REPORT_AT,
      dialect_class: 'self-identified-agent',
      outcome: 'reachable',
      evidence_class: 'observed_status',
      vantage_class: 'residential',
      reporter: { identity_class: 'anonymous' },
      ...over,
    },
  };
}

// Corroborated by our own probe: same domain, same class, same outcome, minutes apart.
const probeEvidence = ROWS.filter((r) => r.kind === 'request' && r.requested).map((r) => ({
  domain: r.domain,
  dialect_class: DIALECT_TO_CLASS[r.dialect],
  outcome: r.outcome,
  observed_at: r.ts,
  vantage_class: 'github-hosted-dynamic-egress',
  capture_id: MANIFEST.capture_id,
}));

const resolution = resolve(
  [
    ledgerEntry('r-match'),
    // Nothing matches this one: different outcome, no verified reporters.
    ledgerEntry('r-quarantined', { outcome: 'blocked', report_id: 'r-quarantined' }),
  ],
  { probeEvidence, now: '2026-08-22T10:00:00.000Z' },
);

const crowdIndex = buildIndex({ manifest: MANIFEST, rows: ROWS, resolution, dialectClasses: DIALECT_TO_CLASS });
const withCrowd = lookup(crowdIndex, 'open.example', { now: NOW_FRESH });

eq(withCrowd.crowd.corroborated.length, 1, 'exactly one claim was promoted');
eq(withCrowd.crowd.corroborated[0].last_outcome, 'reachable', 'and it is the one our own probe matched');
eq(
  withCrowd.crowd.corroborated[0].promotion_reasons,
  ['owned_probe_match'],
  'the reason it was promoted is served with it',
);
eq(withCrowd.crowd.quarantined_claims, 1, 'the unpromoted claim is COUNTED');
eq(
  withCrowd.crowd.corroborated.some((c) => c.last_outcome === 'blocked'),
  false,
  'and it is NEVER served as fact',
);
// The counts are published apart and never added — the same rule reports.mjs
// publishes its four numbers under.
ok(
  withCrowd.crowd.corroborated.length + withCrowd.crowd.quarantined_claims === 2 &&
    !('total_claims' in withCrowd.crowd),
  'there is no combined total for a caller to quote',
);

// Contested: two promoted claims disagreeing at one door. Neither may be served.
const contestedResolution = resolve(
  [
    ledgerEntry('r-a'),
    ledgerEntry('r-b', {
      report_id: 'r-b',
      outcome: 'blocked',
      reporter: { identity_class: 'web_bot_auth', key_thumbprint: 'k1' },
    }),
    ledgerEntry('r-c', {
      report_id: 'r-c',
      outcome: 'blocked',
      reporter: { identity_class: 'web_bot_auth', key_thumbprint: 'k2' },
    }),
  ],
  { probeEvidence, now: '2026-08-22T10:00:00.000Z' },
);
const contestedIndex = buildIndex({
  manifest: MANIFEST,
  rows: ROWS,
  resolution: contestedResolution,
  dialectClasses: DIALECT_TO_CLASS,
});
const contested = lookup(contestedIndex, 'open.example', { now: NOW_FRESH });
eq(contested.crowd.contested_claims, 2, 'both sides of a conflict are counted as contested');
eq(contested.crowd.corroborated, [], 'and NEITHER is served, because serving one would publish a coin flip');

// With no ledger at all the block is present and honest rather than absent.
eq(open.crowd.corroborated, [], 'with no ingest yet, the corroborated list is empty');
eq(open.crowd.resolved_at, null, 'and says it has resolved nothing');
eq(crowdBlock(INDEX, 'never-seen.example').quarantined_claims, 0, 'an unknown host has no claims either');

// --- 9. reproducibility ------------------------------------------------------

throws(() => lookup(INDEX, 'open.example', {}), 'lookup() refuses to invent a clock');
throws(() => datasetStatus(INDEX, {}), 'datasetStatus() refuses to invent a clock');
throws(() => buildIndex({ manifest: {}, rows: [], dialectClasses: DIALECT_TO_CLASS }), 'an index needs a capture_id');
throws(() => buildIndex({ manifest: MANIFEST, rows: [] }), 'an index needs the dialect class map');
eq(
  JSON.stringify(lookup(INDEX, 'open.example', { now: NOW_FRESH })),
  JSON.stringify(lookup(buildIndex({ manifest: MANIFEST, rows: [...ROWS].reverse(), dialectClasses: DIALECT_TO_CLASS }), 'open.example', { now: NOW_FRESH })),
  'the answer does not depend on the order rows arrived in',
);

// --- 10. dataset status is derived, not read off a manifest field -----------

const status = datasetStatus(INDEX, { now: NOW_STALE });
// 5 open.example + 1 declared.example (browser) + 1 tolled.example, hand-counted
// from the fixture rather than read back out of the function under test.
eq(status.doors_by_evidence.behaviour, 7, 'behavioural doors are counted');
eq(status.doors_by_evidence['robots-declaration'], 1, 'one real robots denial in the fixture');
eq(status.doors_by_evidence['not-attempted'], 5, 'five doors skipped by our own fail-closed default');
eq(status.domains_indexed, 4, 'four domains in the fixture');
eq(status.domains_with_any_behavioural_evidence, 3, 'three of them were actually knocked on');
eq(status.as_of.freshness, 'stale', 'the status carries the same freshness rule as an answer');
ok(status.note.includes('not about the hosts'), 'the status says what not-attempted means');

// The coverage numbers must come from the same rows the lookups answer from, or
// a caller could trust a coverage figure that disagrees with every answer.
const byLookup = ['open.example', 'declared.example', 'unreadable.example', 'tolled.example']
  .map((d) => lookup(INDEX, d, { now: NOW_FRESH }).doors)
  .flat();
eq(
  byLookup.filter((d) => d.evidence === 'behaviour').length,
  status.doors_by_evidence.behaviour,
  'coverage agrees with what the lookups actually say, door for door',
);
eq(
  byLookup.filter((d) => d.evidence === 'not-attempted').length,
  status.doors_by_evidence['not-attempted'],
  'and for the not-attempted ones too',
);

// --- 11. the rails, asserted on the source rather than promised -------------
// A reachability tool that probes on demand is an on-request scanner aimed at
// whatever third party the caller names. The charter forbids it, so it is
// checked mechanically here rather than trusted to review.

// This scan used to run over a HAND-LISTED pair, `lookup.mjs` and
// `mcp-server.mjs`. But the server loads whatever those two import, and today
// that is capture.mjs, reports.mjs, dialects.mjs and policy.mjs — four modules
// running inside the tool with the rail asserted on neither. A `fetch(` in any
// of them would have been a probing MCP server under a green rail. Nobody had
// to do anything wrong for that hole to open: it opened the moment a module
// grew an import, which is the ninth time this repository has found that a list
// covers what its author thought of.
//
// So the graph is WALKED from the entry points instead of enumerated.

const RAIL_ENTRY_POINTS = ['lookup.mjs', 'mcp-server.mjs'];

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * Drop a module's CLI main block.
 *
 * The rail being asserted is "nothing the SERVER can reach touches the network,
 * a process, or the disk". Several of these modules are also runnable scripts,
 * and `aggregate.mjs`'s `--out` flag writes a file — from inside
 * `if (import.meta.url === \`file://${process.argv[1]}\`)`, which the server can
 * never enter, because the server is not argv[1].
 *
 * That is a real boundary, not a convenient one, but a stripper that quietly
 * matched nothing would silently restore the old two-file coverage while the
 * loop still read as seven. So it is checked below: it must have fired at least
 * once across the graph, and it must both remove a guarded block and keep the
 * code around it.
 */
const CLI_MAIN = /if\s*\(\s*import\.meta\.url\s*===[\s\S]*$/;
const stripCliMain = (code) => code.replace(CLI_MAIN, '');

/** Every local module reachable from `entries` by a static import. */
function localImportGraph(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    // Comments are stripped BEFORE extraction, not after. lookup.mjs's own
    // prose names `./probe.mjs` while explaining that it never imports it, and
    // an extractor reading comments would pull the prober into the graph and
    // fail the rail on the strength of a sentence.
    const code = stripComments(readFileSync(join(HERE, file), 'utf8'));
    for (const m of code.matchAll(/\bfrom\s+'(\.\/[^']+)'/g)) queue.push(m[1].slice(2));
  }
  return [...seen].sort();
}

const railModules = localImportGraph(RAIL_ENTRY_POINTS);

// The generalization has to actually generalize. If the walk returned only the
// two entry points, every check below would be the old hand-listed check
// wearing a loop, and it would read as broader coverage while covering the same
// two files.
ok(
  railModules.length > RAIL_ENTRY_POINTS.length,
  `the import walk found only ${railModules.join(', ')}; it is not reaching past the entry points`,
);
ok(
  !railModules.includes('probe.mjs'),
  `the prober is reachable from the MCP server through ${railModules.join(', ')}`,
);

let cliBlocksStripped = 0;
for (const file of railModules) {
  const full = stripComments(readFileSync(join(HERE, file), 'utf8'));
  const code = stripCliMain(full);
  if (code.length !== full.length) cliBlocksStripped++;
  ok(!/\bfetch\s*\(/.test(code), `${file} makes no fetch call`);
  ok(!/child_process|node:http|node:net|node:dgram|node:tls/.test(code), `${file} opens no process or socket`);
  // Call sites, not identifiers — the same shape as the `fetch(` check beside
  // it. `aggregate.mjs` imports `writeFileSync` at module scope and calls it
  // only from its CLI block, and a bare name in an import list writes nothing.
  // Matching the name flagged that as a disk write, which is the kind of false
  // positive that gets a rail relaxed rather than fixed.
  ok(!/\b(writeFileSync|appendFileSync|rmSync|unlinkSync)\s*\(/.test(code), `${file} writes nothing to disk`);
}
ok(cliBlocksStripped > 0, 'the CLI-main stripper matched nothing anywhere; the rail is scanning whole files again');
console.log(
  `ok   no-network rail asserted on ${railModules.length} modules (${cliBlocksStripped} CLI blocks excluded): ${railModules.join(', ')}`,
);

// And the rail is enforceable: the check can fail.
ok(/\bfetch\s*\(/.test('const x = await fetch(url)'), 'the fetch pattern matches a real fetch call');
ok(!/\bfetch\s*\(/.test('// we never fetch anything\n'.replace(/^\s*\/\/.*$/gm, '')), 'a comment about fetching does not trip it');
// And the extractor can fail: it finds a real import, and ignores one in prose.
ok(
  [...stripComments("import { x } from './neighbour.mjs';").matchAll(/\bfrom\s+'(\.\/[^']+)'/g)].length === 1,
  'the import extractor finds a real local import',
);
ok(
  [...stripComments("// never: from './probe.mjs'\n").matchAll(/\bfrom\s+'(\.\/[^']+)'/g)].length === 0,
  'the import extractor ignores an import named in a comment',
);
// And the CLI stripper cuts in the right place: the guarded block goes, the
// module body around it stays. A stripper that ate the whole file would make
// every rail check above vacuously pass.
{
  const sample = "export const a = 1;\nif (import.meta.url === `file://${process.argv[1]}`) {\n  writeFileSync(x, y);\n}\n";
  const stripped = stripCliMain(sample);
  ok(!/writeFileSync/.test(stripped), 'the CLI stripper removes a guarded main block');
  ok(/export const a = 1;/.test(stripped), 'the CLI stripper keeps the module body');
  ok(stripCliMain('export const a = 1;\n') === 'export const a = 1;\n', 'the CLI stripper leaves a guardless module alone');
}
// The write check discriminates a call from a name in an import list.
{
  const w = /\b(writeFileSync|appendFileSync|rmSync|unlinkSync)\s*\(/;
  ok(w.test('writeFileSync(path, body)'), 'the write pattern matches a real write call');
  ok(!w.test("import { readFileSync, writeFileSync } from 'node:fs';"), 'an unused import is not a write');
}

// --- 11b. the profile and the policy the capture ACTUALLY ran ---------------
// A coverage number without these is an instrument choice dressed as a fact
// about the web: the residential baseline and the automated series differ on
// the same 1,000 domains by thousands of doors, entirely because of what each
// did when robots.txt could not be read.

// Derived from the delta gate's own list, so a dimension added there appears
// here without anyone remembering. Hand-listing the keys would let the
// published profile silently describe a narrower gate than the one that runs.
eq(
  Object.keys(comparabilityProfile(MANIFEST)).join(','),
  [...COMPARABILITY_DIMENSIONS].join(','),
  'the comparability profile carries exactly the dimensions the delta gate uses',
);
eq(comparabilityProfile(MANIFEST)['vantage.class'], 'github-hosted-dynamic-egress', 'a recorded vantage reads through');
eq(
  comparabilityProfile(MANIFEST)['instrument_policy.robots_unavailable'],
  'fail-closed-except-404-410',
  'a recorded robots-unavailable policy reads through',
);
// This fixture's manifest predates the redirect dimension, exactly as the v1
// baseline predates all of them.
eq(
  comparabilityProfile(MANIFEST)['instrument_policy.robots_redirects'],
  UNRECORDED,
  'a dimension the manifest predates reads `unrecorded`',
);
eq(comparabilityProfile({ capture_id: 'x' })['vantage.class'], UNRECORDED, 'a manifest with no vantage block reads `unrecorded`');

// Four fixtures, one per observable policy. The site suite that shipped before
// this change ran against two datasets that BOTH failed open, so every check
// touching the not-attempted count was arithmetic on a zero and a mutant walked
// out. A fixture family missing the class the code exists to describe cannot
// test the code, so the control below refuses to pass if these collapse.
const policyRows = (doors) =>
  doors.map(([known, requested], i) => ({
    ...base,
    domain: `policy${i}.example`,
    kind: 'request',
    dialect: 'browser',
    robots: { allowed: requested, reason: known ? 'no-matching-rule' : 'robots-policy-unknown-http-503', known },
    requested,
    outcome: requested ? 'reachable' : 'denied_by_robots',
  }));
const policyIndex = (doors, manifest = MANIFEST) =>
  buildIndex({ manifest, rows: policyRows(doors), dialectClasses: DIALECT_TO_CLASS });

const POLICY_CASES = {
  'fail-open': [
    [false, true],
    [false, true],
  ],
  'fail-closed': [
    [false, false],
    [false, false],
  ],
  mixed: [
    [false, true],
    [false, false],
  ],
  'no-unreadable-robots-observed': [
    [true, true],
    [true, true],
  ],
};

for (const [expected, doors] of Object.entries(POLICY_CASES)) {
  const b = robotsUnavailableBehaviour(policyIndex(doors));
  eq(b.observed_policy, expected, `a capture whose unreadable-robots doors are ${expected} is observed as ${expected}`);
  eq(
    b.probed_anyway + b.skipped,
    b.doors_with_unreadable_robots,
    `${expected}: the two halves account for every unreadable door`,
  );
}

// Without this, all four cases could describe the same dataset and every
// assertion above would still pass while testing one branch four times.
eq(
  new Set(Object.values(POLICY_CASES).map((d) => robotsUnavailableBehaviour(policyIndex(d)).observed_policy)).size,
  Object.keys(POLICY_CASES).length,
  'the four policy fixtures are actually distinguishable',
);

// Observed comes from the bytes; declared comes from the manifest. A manifest
// that says the opposite of what the rows did must not be able to overwrite
// them - that is the whole reason both are published.
const LYING = policyIndex(POLICY_CASES['fail-closed'], {
  ...MANIFEST,
  instrument_policy: { robots_unavailable: 'fail-open' },
});
eq(robotsUnavailableBehaviour(LYING).declared_policy, 'fail-open', 'the declared policy is reported verbatim');
eq(
  robotsUnavailableBehaviour(LYING).observed_policy,
  'fail-closed',
  'the observed policy comes from the rows regardless of what the manifest declares',
);

{
  const b = robotsUnavailableBehaviour(INDEX);
  const note = datasetStatus(INDEX, { now: NOW_FRESH }).note;
  ok(note.includes(`\`${b.observed_policy}\``), 'the status note states the policy the capture was observed to run');
  ok(note.includes(`\`${b.declared_policy}\``), 'the status note states the policy the manifest declares');
  // The sentence this replaced ended "and this instrument fails closed" - true
  // of the automated series, false of the baseline the site serves, and shipped
  // to a calling model either way.
  ok(!/this instrument fails closed/.test(note), 'the status note reads a policy rather than asserting one');
}

// --- 12. against the real published capture, when one is beside us ----------
// Fixtures prove the rules; the published bytes prove the rules survive contact
// with the dataset. The suite always runs either way — a gate that only runs on
// the author's laptop is not enforcing anything.

const probeDir = join(HERE, '..', 'data', 'probes');
const manifestFile = existsSync(probeDir)
  ? readdirSync(probeDir)
      .filter((f) => f.endsWith('.manifest.json'))
      .sort()
      .pop()
  : null;

if (manifestFile) {
  const { loadVerifiedCapture, resolveCapturePath } = await import('./capture.mjs');
  const manifestPath = join(probeDir, manifestFile);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const capturePath = resolveCapturePath(manifestPath, manifest, null);
  if (existsSync(capturePath)) {
    const { rows } = loadVerifiedCapture(capturePath, manifestPath);
    const real = buildIndex({ manifest, rows, dialectClasses: DIALECT_TO_CLASS });
    const realStatus = datasetStatus(real, { now: NOW_FRESH });

    ok(realStatus.domains_indexed >= 900, `real capture indexes ${realStatus.domains_indexed} domains`);
    // The headline of this whole module, measured rather than asserted: on the
    // real capture, most doors were never knocked on.
    ok(
      realStatus.doors_by_evidence['not-attempted'] > realStatus.doors_by_evidence.behaviour,
      `not-attempted (${realStatus.doors_by_evidence['not-attempted']}) exceeds behaviour (${realStatus.doors_by_evidence.behaviour}) on the real capture — which is why this distinction is structural`,
    );
    // Every door of every domain: no outcome may be served without a request.
    let served = 0;
    for (const domain of [...real.byDomain.keys()].slice(0, 250)) {
      const answer = lookup(real, domain, { now: NOW_FRESH });
      assertNoPresentTenseField(answer);
      for (const door of answer.doors) {
        if (door.last_outcome !== null) {
          served++;
          if (door.evidence !== 'behaviour') failures.push(`${domain}: outcome served for a ${door.evidence} door`);
        }
      }
    }
    pass++;
    ok(served > 0, `${served} behavioural outcomes served across 250 real domains — the check is not vacuous`);
    // A host absent from the real capture is still unknown, not inferred.
    eq(
      lookup(real, 'this-host-is-not-in-the-tranco-list.invalid', { now: NOW_FRESH }).answer,
      'unknown',
      'an unlisted host is unknown against the real capture too',
    );
    console.error(`  (also checked against the published capture ${manifest.capture_id})`);
  }
} else {
  console.error('  (no published capture beside this checkout; fixture suite only)');
}

// --- report ------------------------------------------------------------------

if (failures.length) {
  console.error(`FAIL ${failures.length} of ${pass + failures.length}`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`ok  ${pass} assertions (traveler's answer engine)`);
