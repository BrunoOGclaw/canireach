// Vacuity guard for the cross-capture gate. Harness: tools/mutate.mjs
//
// Run: node tools/mutate-compare.mjs
//
// This module computes the number the launch post cites, and until #29 it was the
// only substantial module in the repo with a test suite and no vacuity guard. That
// asymmetry is exactly the one this project keeps finding: the suite read as
// thorough, and every defect #29 fixed was invisible to it. Each mutant below
// restores one of those defects, so a revert has to go red rather than quiet.

import { runMutants } from './mutate.mjs';

const MUTANTS = [
  // --- an undefined quantity is not zero -------------------------------------
  // The whole guard removed: `null` coerces to 0 under `-`, so a rate that went
  // undefined publishes as a measured collapse and two undefined rates publish as
  // "no change".
  [
    'an undefined rate subtracts as zero',
    "  if (before == null || after == null) {\n    return { before: before ?? null, after: after ?? null, change: null };\n  }\n",
    '',
  ],
  // Half the guard: only the BEFORE side checked. The surviving case is the one
  // that matters most — tonight's capture going dark against a lit prior night.
  [
    'only the earlier side may be undefined',
    'if (before == null || after == null) {',
    'if (before == null) {',
  ],
  // The guard fires but reports a number anyway.
  [
    'an undefined change is published as zero',
    'return { before: before ?? null, after: after ?? null, change: null };',
    'return { before: before ?? null, after: after ?? null, change: 0 };',
  ],
  // The rate itself stops being undefined, which would re-enter the same lie one
  // step earlier: a night that sent nothing would report a reachable rate of 0.
  [
    'a capture that sent nothing reports a rate of zero',
    'return denominator ? round(numerator / denominator, RATE_PRECISION) : null;',
    'return denominator ? round(numerator / denominator, RATE_PRECISION) : 0;',
  ],

  // --- a change carries no more precision than its own sides -----------------
  [
    'the change is not rounded at all',
    'change: precision === undefined ? change : round(change, precision)',
    'change',
  ],
  // Rounding survives but at a precision the sides never had, which is the same
  // defect wearing a rounder-looking number.
  [
    'the change is rounded at a coarser precision than the sides',
    '{ precision: RATE_PRECISION }',
    '{ precision: 2 }',
  ],

  // --- the robots verdict stays split ----------------------------------------
  [
    'the robots split is not published',
    'robots_policy: policyDelta(a.robots_policy, b.robots_policy),',
    '',
  ],
  // Published, but folded into a single per-dialect number — which is precisely
  // `outcomes.denied_by_robots`, the flattening this block exists to undo.
  [
    'refusals and unreadability are added together',
    "      counters[key] = observedBoth\n        ? delta(b[key] ?? 0, a[key] ?? 0)\n        : delta(b?.[key] ?? null, a?.[key] ?? null);",
    "      counters[key] = delta((b?.denied ?? 0) + (b?.unknown ?? 0), (a?.denied ?? 0) + (a?.unknown ?? 0));",
  ],
  // A dialect only one capture probed reads as a rise from zero.
  [
    'an unprobed dialect counts as zero',
    'const observedBoth = Boolean(b) && Boolean(a);',
    'const observedBoth = true;',
  ],

  // --- the union rules -------------------------------------------------------
  // A category or dialect that vanished must still appear. Reading only the later
  // side's keys makes a disappearance invisible instead of a finding.
  [
    'only the later capture contributes keys',
    'const unionKeys = (a = {}, b = {}) => [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();',
    'const unionKeys = (a = {}, b = {}) => Object.keys(b).sort();',
  ],

  // --- the caveat names acknowledged confounders only ------------------------
  [
    'unacknowledged confounders are printed as acknowledged',
    'caveat: confounders.some((c) => c.acknowledged)\n      ? `acknowledged confounders: ${confounders.filter((c) => c.acknowledged).map((c) => c.dimension).join(', ')}`',
    'caveat: confounders.length\n      ? `acknowledged confounders: ${confounders.map((c) => c.dimension).join(', ')}`',
  ],

  // --- the gate itself, so this registry is not only about presentation ------
  [
    'a differing dimension no longer blocks',
    'if (!isAcknowledged) blocking.push(path);',
    'void isAcknowledged;',
  ],
  [
    'a withheld comparison emits its delta anyway',
    'delta: comparable ? compareAggregates(beforeManifest.aggregates ?? {}, afterManifest.aggregates ?? {}) : null,',
    'delta: compareAggregates(beforeManifest.aggregates ?? {}, afterManifest.aggregates ?? {}),',
  ],
  [
    'a misspelled acknowledgement is ignored instead of refused',
    'throw new Error(`unknown comparability dimension: ${unknown.join(\', \')}`);',
    'void unknown;',
  ],
  [
    'the rate is taken over all request rows rather than requests sent',
    'rate(b.outcomes?.reachable ?? 0, sentAfter),',
    'rate(b.outcomes?.reachable ?? 0, b.rows ?? 0),',
  ],
  // --- added AFTER the first pass came back 15/15 ----------------------------
  // A registry that only names the obvious breaks reads as thorough while testing
  // the easy half. These four were written against the parts of the suite that
  // looked least defended, not against the fixes above.

  // The published artifact must be byte-reproducible: two runs over the same
  // captures, with the API returning keys in a different order, have to produce
  // the same file or a reader diffing two nights sees changes that are ordering.
  [
    'key order follows input order rather than being sorted',
    '[...new Set([...Object.keys(a), ...Object.keys(b)])].sort()',
    '[...new Set([...Object.keys(a), ...Object.keys(b)])]',
  ],
  // `strictly_comparable` is the field that says "nothing was acknowledged".
  // Collapsing it into `comparable` makes an acknowledged confounder look like a
  // clean comparison, which is the one thing acknowledgement must never buy.
  [
    'an acknowledged confounder reads as strictly comparable',
    'strictly_comparable: confounders.length === 0,',
    'strictly_comparable: comparable,',
  ],
  // The two sides travel with the change so a reader never reconstructs them.
  // Dropping one leaves a signed number with nothing to anchor it.
  [
    'the change is published without its sides',
    'return { before, after, change: precision === undefined ? change : round(change, precision) };',
    'return { change: precision === undefined ? change : round(change, precision) };',
  ],
  // The `unrecorded` rule lives in policy.mjs, but this module is where it is
  // consumed: a confounder must be recorded as such even when acknowledged.
  [
    'an acknowledged difference stops being recorded as a confounder',
    'confounders.push({',
    'if (isAcknowledged) continue;\n    confounders.push({',
  ],
];

process.exit(runMutants({ module: 'compare.mjs', suite: 'test-compare.mjs', mutants: MUTANTS }));
