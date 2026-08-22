// Cross-capture comparison, with the confounders as a gate rather than a caveat.
//
// The launch claim this project exists to make is a difference between two
// nights. A difference is only about the web if the instrument held still, so
// this tool refuses to emit one across captures that disagree on any
// comparability dimension (tools/policy.mjs) unless the operator names that
// dimension explicitly with --acknowledge.
//
// Acknowledging is not a bypass: an acknowledged dimension is carried into the
// output as a named confounder, so a delta produced across a vantage change
// cannot be quoted without the vantage change travelling attached to it.
//
// A manifest that predates the `aggregates` block is still admissible. The one
// capture this whole comparison exists for — the immutable pre-September-15
// baseline — is schema v1 and can never be regenerated in place, so its
// aggregates are recomputed from its own bytes, admitted only when those bytes
// hash to the SHA-256 the manifest published. That is a load-bearing distinction:
// a refusal for a STRUCTURAL reason would mask whether the substantive gate below
// works at all, and an exit code that never reached the gate would still read
// like the gate holding.
//
// Usage:
//   node tools/compare.mjs --before A.manifest.json --after B.manifest.json
//                          [--before-capture FILE] [--after-capture FILE]
//                          [--acknowledge <dimension>]... [--out FILE]
// Exit codes: 0 comparable (or fully acknowledged), 2 usage/load failure,
//             3 delta withheld.

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PUBLISHED, loadManifestAggregates } from './capture.mjs';
import { COMPARABILITY_DIMENSIONS, UNRECORDED, dimensionValue, dimensionsAgree } from './policy.mjs';

const WITHHELD = 3;

// The precision the rates are published at. One constant, read by both the side
// and the change computed from it, so a change can never carry digits its own
// operands never had.
const RATE_PRECISION = 4;

const round = (value, precision) => Number(value.toFixed(precision));

const unionKeys = (a = {}, b = {}) => [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();

/**
 * Signed change plus the two sides, so a reader never has to reconstruct them.
 *
 * A `null` side is an UNDEFINED quantity, not zero, and the change across one is
 * `null` rather than a number. JavaScript's `-` coerces `null` to `0`, so the
 * obvious `after - before` publishes a rate that went undefined as a measured
 * collapse (`0.491 -> null` became `change: -0.491`) and two undefined rates as
 * `change: 0` — "no change" between two nights whose rate was never known. That
 * is `unrecorded` never equalling `unrecorded` (tools/policy.mjs), violated one
 * layer down in arithmetic instead of in a comparison, and it is reachable in
 * exactly the direction this project watches: `requests_sent` collapses toward
 * zero when robots.txt goes unreadable across the population and the instrument
 * fails closed. The instrument going dark and the web going dark must not
 * produce the same published number.
 *
 * `precision` rounds the change at the precision of the sides. Without it a
 * 0.507 -> 0.407 change publishes as `-0.09999999999999998`, into an artifact the
 * launch post cites.
 */
function delta(before, after, { precision } = {}) {
  // `== null` deliberately, covering both null and undefined in one test: an
  // absent side reaching here as `undefined` would otherwise be dropped from the
  // JSON entirely, which reads as a field that was never computed.
  if (before == null || after == null) {
    return { before: before ?? null, after: after ?? null, change: null };
  }
  const change = after - before;
  return { before, after, change: precision === undefined ? change : round(change, precision) };
}

/** Counter maps are compared over the UNION of keys: a category that vanished is a finding. */
function countDelta(before = {}, after = {}) {
  const out = {};
  for (const key of unionKeys(before, after)) {
    out[key] = delta(before[key] ?? 0, after[key] ?? 0);
  }
  return out;
}

/**
 * The robots verdict, per dialect, kept SPLIT.
 *
 * `outcomes.denied_by_robots` is the sum of two facts that mean opposite things:
 * the site's robots.txt was read and says no, and the site's robots.txt could not
 * be read at all so this instrument failed closed. On the real capture the split
 * is exact across every dialect — `denied + unknown = denied_by_robots` — and only
 * the first is a fact about the host. A delta that publishes the sum and not the
 * split reports our own compliance as the web's hostility, which is the finding
 * from the traveler's answer engine (#17) arriving one layer out, in the artifact
 * that carries the September-15 claim. That claim is precisely a claim about
 * WHICH of the two moved.
 *
 * A dialect ABSENT from one capture was not observed by it. Unlike an absent
 * outcome category — which means the outcome occurred zero times — an absent
 * dialect means the instrument never asked, so its counters are undefined and
 * their changes are `null`. Reading them as zero would publish "denied rose from
 * 0 to 27" for a dialect that was simply not probed: the same fabricated change
 * `delta` above now refuses for an undefined rate.
 */
function policyDelta(before = {}, after = {}) {
  const out = {};
  for (const dialect of unionKeys(before, after)) {
    const b = before[dialect];
    const a = after[dialect];
    const observedBoth = Boolean(b) && Boolean(a);
    const counters = {};
    for (const key of unionKeys(b ?? {}, a ?? {})) {
      counters[key] = observedBoth
        ? delta(b[key] ?? 0, a[key] ?? 0)
        : delta(b?.[key] ?? null, a?.[key] ?? null);
    }
    out[dialect] = counters;
  }
  return out;
}

function rate(numerator, denominator) {
  return denominator ? round(numerator / denominator, RATE_PRECISION) : null;
}

export function compareAggregates(a, b) {
  const sentBefore = a.requests_sent ?? 0;
  const sentAfter = b.requests_sent ?? 0;
  return {
    domains: delta(a.domains ?? 0, b.domains ?? 0),
    requests_sent: delta(sentBefore, sentAfter),
    // Rate over requests SENT, matching aggregate.mjs. Dividing by all request
    // rows would count our own robots compliance as the web's hostility, and a
    // delta computed that way would move whenever our compliance did.
    reachable_rate_of_sent: delta(
      rate(a.outcomes?.reachable ?? 0, sentBefore),
      rate(b.outcomes?.reachable ?? 0, sentAfter),
      { precision: RATE_PRECISION },
    ),
    outcomes: countDelta(a.outcomes, b.outcomes),
    // Published BESIDE outcomes, never folded into them: `denied_by_robots` above
    // is `denied + unknown` and cannot answer which one moved.
    robots_policy: policyDelta(a.robots_policy, b.robots_policy),
    challenges: countDelta(a.challenges, b.challenges),
    toll: countDelta(a.toll, b.toll),
    affordances: Object.fromEntries(
      unionKeys(a.affordances, b.affordances)
        .map((id) => [id, delta(a.affordances?.[id]?.present ?? 0, b.affordances?.[id]?.present ?? 0)]),
    ),
  };
}

export function compareManifests(
  beforeManifest,
  afterManifest,
  { acknowledge = [], aggregatesSource = {} } = {},
) {
  const acknowledged = new Set(acknowledge);
  const unknown = [...acknowledged].filter((d) => !COMPARABILITY_DIMENSIONS.includes(d));
  if (unknown.length) {
    // Silently ignoring an unknown dimension name would let a typo read as an
    // acknowledgement and quietly release a withheld delta.
    throw new Error(`unknown comparability dimension: ${unknown.join(', ')}`);
  }

  const dimensions = {};
  const confounders = [];
  const blocking = [];
  for (const path of COMPARABILITY_DIMENSIONS) {
    const before = dimensionValue(beforeManifest, path);
    const after = dimensionValue(afterManifest, path);
    const equal = dimensionsAgree(before, after);
    const isAcknowledged = acknowledged.has(path);
    dimensions[path] = { before, after, equal, acknowledged: isAcknowledged };
    if (equal) continue;
    // `unrecorded` on either side is a difference, not a match. Two captures
    // whose policy nobody wrote down are not thereby known to share one.
    confounders.push({
      dimension: path,
      before,
      after,
      unrecorded: before === UNRECORDED || after === UNRECORDED,
      acknowledged: isAcknowledged,
    });
    if (!isAcknowledged) blocking.push(path);
  }

  const comparable = blocking.length === 0;
  return {
    comparable,
    strictly_comparable: confounders.length === 0,
    before: {
      capture_id: beforeManifest.capture_id ?? null,
      observed_from: beforeManifest.observed_from ?? null,
      instrument_commit: beforeManifest.instrument_commit ?? null,
      // A reader of a delta is entitled to know which side's numbers were
      // regenerated today rather than published on the night of the capture.
      aggregates_source: aggregatesSource.before ?? PUBLISHED,
    },
    after: {
      capture_id: afterManifest.capture_id ?? null,
      observed_from: afterManifest.observed_from ?? null,
      instrument_commit: afterManifest.instrument_commit ?? null,
      aggregates_source: aggregatesSource.after ?? PUBLISHED,
    },
    dimensions,
    confounders,
    blocking_dimensions: blocking,
    // Withheld, not merely flagged. A number printed beside a warning gets
    // quoted without the warning.
    delta: comparable ? compareAggregates(beforeManifest.aggregates ?? {}, afterManifest.aggregates ?? {}) : null,
    withheld_reason: comparable
      ? null
      : `instrument differs on ${blocking.join(', ')}; any delta would describe the instrument, not the web`,
    // Travels with the numbers so it cannot be dropped in transcription. It names
    // ACKNOWLEDGED confounders only: mapping over every confounder printed
    // dimensions nobody acknowledged under the word "acknowledged", which is a
    // false sentence in the one line built to survive being quoted. When a delta
    // is emitted the two sets coincide — an unacknowledged confounder is blocking
    // — so this narrowing changes only the withheld output, where `blocking_dimensions`
    // and `confounders` already carry the full picture.
    caveat: confounders.some((c) => c.acknowledged)
      ? `acknowledged confounders: ${confounders.filter((c) => c.acknowledged).map((c) => c.dimension).join(', ')}`
      : null,
  };
}

/**
 * A side of the comparison: the manifest, plus aggregates from wherever they can
 * honestly be got. `side` only shapes the error message, so an operator is told
 * which flag to reach for.
 */
function readSide(path, capturePath, side) {
  try {
    return loadManifestAggregates(path, { capturePath });
  } catch (err) {
    throw new Error(String(err.message || err).replace('--{side}-capture', `--${side}-capture`));
  }
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : null;
  };
  const before = opt('--before');
  const after = opt('--after');
  const out = opt('--out');
  const acknowledge = args.flatMap((a, i) => (a === '--acknowledge' && args[i + 1] ? [args[i + 1]] : []));
  if (!before || !after) {
    console.error('usage: node tools/compare.mjs --before A.manifest.json --after B.manifest.json [--before-capture FILE] [--after-capture FILE] [--acknowledge DIM]... [--out FILE]');
    process.exit(2);
  }

  const b = readSide(before, opt('--before-capture'), 'before');
  const a = readSide(after, opt('--after-capture'), 'after');
  const result = compareManifests(
    { ...b.manifest, aggregates: b.aggregates },
    { ...a.manifest, aggregates: a.aggregates },
    { acknowledge, aggregatesSource: { before: b.source, after: a.source } },
  );
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (out) writeFileSync(out, json);
  else process.stdout.write(json);

  if (!result.comparable) {
    console.error(`comparison withheld: ${result.withheld_reason}`);
    process.exit(WITHHELD);
  }
  if (result.caveat) console.error(result.caveat);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(String(err.message || err));
    process.exit(2);
  });
}
