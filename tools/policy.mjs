// The instrument's comparability profile.
//
// WHY THIS FILE EXISTS. The whole point of this project is a before/after claim
// about September 15. A delta between two captures only describes the WEB when
// the instrument made the same choices on both nights; otherwise it describes
// US. There is already one such discontinuity in the record: the first baseline
// (2026-08-22T0815Z) was captured from a residential host with an unreadable
// robots.txt failing OPEN, and every capture from the automated series onward
// runs from a GitHub-hosted dynamic egress with policy failing CLOSED. Both
// shifts move the numbers on their own, and both move them in the direction
// that looks like "the web got harder" — which is exactly the claim under test.
//
// So the profile is recorded into every manifest and compared mechanically by
// tools/compare.mjs. Remembering to mention a confounder in prose is not a
// mechanism; refusing to emit the delta is.
//
// EVERY VALUE HERE IS A CLAIM ABOUT BEHAVIOUR, and a declaration that drifts
// from the code it describes is worse than no declaration at all — it is a
// confounder that reads as controlled. tools/test-policy.mjs derives each value
// back out of the running instrument and fails if the two disagree, so flipping
// the code without flipping this file (or the reverse) is a red build.

import { DIALECTS } from './dialects.mjs';

/** Row schema written by probe.mjs. v1 bytes exist and are immutable. */
export const ROW_SCHEMA_VERSION = 2;

export const INSTRUMENT_POLICY = {
  profile_version: 1,
  row_schema_version: ROW_SCHEMA_VERSION,
  // What happens when robots.txt cannot be read as policy.
  robots_unavailable: 'fail-closed-except-404-410',
  // What happens on a 3xx.
  redirects: 'recorded-never-followed',
  // What happens after a denial.
  denial_gate: 'no-request-past-a-denial',
  // Which identities were presented. Derived, so it cannot drift from dialects.mjs.
  dialects: DIALECTS.map((d) => d.id).sort(),
};

/**
 * The dimensions two captures must agree on before a delta between them is a
 * statement about the web. Dotted paths into the release manifest.
 *
 * `input.sha256` is here because a delta across two different domain lists is
 * not a delta at all; it will matter the day the list grows past the top 1,000.
 */
export const COMPARABILITY_DIMENSIONS = [
  'vantage.class',
  'input.sha256',
  'instrument_policy.row_schema_version',
  'instrument_policy.robots_unavailable',
  'instrument_policy.redirects',
  'instrument_policy.denial_gate',
  'instrument_policy.dialects',
];

/**
 * Read a dotted path out of a manifest. A manifest that predates a dimension
 * reports `unrecorded` rather than `undefined`, and `unrecorded` is never equal
 * to anything — including another `unrecorded`. Two captures whose policy is
 * unknown are not thereby known to share one.
 */
export function dimensionValue(manifest, path) {
  let node = manifest;
  for (const key of path.split('.')) {
    if (node === null || typeof node !== 'object' || !(key in node)) return UNRECORDED;
    node = node[key];
  }
  return node === undefined ? UNRECORDED : node;
}

export const UNRECORDED = 'unrecorded';

export function dimensionsAgree(a, b) {
  if (a === UNRECORDED || b === UNRECORDED) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
