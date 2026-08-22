// Vacuity guard for the crowd-report quarantine tests. Harness: tools/mutate.mjs
//
// This module's entire job is to REFUSE things, and a suite of refusal tests is
// the easiest kind to write vacuously: assert that a bad report is rejected, and
// a module that rejected everything would pass. So every refusal below is broken
// on purpose and the suite has to notice.
//
// Run: node tools/mutate-reports.mjs

import { runMutants } from './mutate.mjs';

const MUTANTS = [
  // --- the corroboration threshold itself
  ['one reporter is enough to promote', 'export const MIN_INDEPENDENT_REPORTERS = 2;', 'export const MIN_INDEPENDENT_REPORTERS = 1;'],
  [
    'unverified identities count toward independence',
    'if (IDENTITY_CLASSES[r.identity_class].verified && r.key_thumbprint) identities.add(r.key_thumbprint);',
    'identities.add(r.key_thumbprint ?? e.report.report_id);',
  ],
  ['assertions become promotable', "const UNPROMOTABLE_EVIDENCE = new Set(['assertion']);", 'const UNPROMOTABLE_EVIDENCE = new Set([]);'],
  [
    'quarantine stops being the default',
    "state: expired ? 'expired' : reasons.length ? 'corroborated' : 'quarantined',",
    "state: expired ? 'expired' : 'corroborated',",
  ],

  // --- the two keys, which are the whole anti-inflation mechanism
  [
    'submission key ignores who sent it',
    'return sha(`${identity}|${report.report_id}`);',
    'return sha(`${report.report_id}`);',
  ],
  [
    'claim key is scoped to the reporter, so nobody ever corroborates anybody',
    '[report.domain, report.dialect_class, report.outcome, windowBucket(report.observed_at)].join',
    '[report.domain, report.dialect_class, report.outcome, windowBucket(report.observed_at), report.reporter.key_thumbprint].join',
  ],
  [
    'claim key drops the outcome, so disagreement averages into agreement',
    'report.outcome, windowBucket(report.observed_at)',
    'windowBucket(report.observed_at)',
  ],
  [
    'group order follows arrival again',
    'group.reports.sort((x, y) => submissionKey(x.report).localeCompare(submissionKey(y.report)));',
    'void 0;',
  ],

  // --- probe matching
  [
    'a probe from any hour corroborates',
    'if (minutesApart(p.observed_at, report.observed_at) > PROBE_MATCH_MAX_LAG_MINUTES) continue;',
    'void 0;',
  ],
  ['a probe with a different outcome corroborates', 'if (p.outcome !== report.outcome) continue;', 'void 0;'],
  ['a probe of a different identity corroborates', 'if (p.dialect_class !== report.dialect_class) continue;', 'void 0;'],
  ['a probe of a different domain corroborates', 'if (p.domain !== report.domain) continue;', 'void 0;'],

  // --- the envelope
  ['unknown fields are accepted', 'for (const key of Object.keys(value)) {', 'for (const key of []) {'],
  ['the forbidden-field tripwire never fires', 'if (forbidden.has(key)) offenders.push(path);', 'void 0;'],
  ['observations from the future are accepted', 'if (observed > received + skewMs)', 'if (false)'],
  [
    'a thumbprint on an unverified class is silently ignored',
    'if (!identity.requires_thumbprint && thumbprint) {',
    'if (false) {',
  ],

  // --- time
  ['retention never expires anything', 'export const RETENTION_DAYS = 90;', 'export const RETENTION_DAYS = 9000;'],
  [
    'week-old observations may still corroborate',
    'Date.parse(e.received_at) - Date.parse(e.report.observed_at) <= maxLagMs,',
    'true,',
  ],
  ['the abuse ceiling counts all of history', 'if (Date.parse(e.received_at) < since) continue;', 'void 0;'],

  // --- the dialect mapping, which is derived precisely so it cannot go quiet
  [
    'an unmapped dialect kind falls back to unrecorded instead of throwing',
    "if (!cls) throw new Error(`dialect '${d.id}' has kind '${d.kind}' with no reporter class`);",
    "if (!cls) return [d.id, 'unrecorded'];",
  ],
  [
    'the vendor dialect kind loses its mapping',
    "  'vendor-token-disclosed': 'vendor-token',\n",
    '',
  ],

  // --- the counts
  ['contested needs three claims instead of two', 'if (gs.length < 2) continue;', 'if (gs.length < 3) continue;'],
  [
    'identities are summed across claims instead of unioned',
    'const identities = new Set(claims.flatMap((c) => c.verified_identities ?? []));',
    'const identities = { size: claims.reduce((n, c) => n + c.distinct_verified_identities, 0) };',
  ],
];

process.exit(runMutants({ module: 'reports.mjs', suite: 'test-reports.mjs', mutants: MUTANTS }));
