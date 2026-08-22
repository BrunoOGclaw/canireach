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

/** Signed change plus the two sides, so a reader never has to reconstruct them. */
function delta(before, after) {
  return { before, after, change: after - before };
}

/** Counter maps are compared over the UNION of keys: a category that vanished is a finding. */
function countDelta(before = {}, after = {}) {
  const out = {};
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    out[key] = delta(before[key] ?? 0, after[key] ?? 0);
  }
  return out;
}

function rate(numerator, denominator) {
  return denominator ? Number((numerator / denominator).toFixed(4)) : null;
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
    ),
    outcomes: countDelta(a.outcomes, b.outcomes),
    challenges: countDelta(a.challenges, b.challenges),
    toll: countDelta(a.toll, b.toll),
    affordances: Object.fromEntries(
      [...new Set([...Object.keys(a.affordances ?? {}), ...Object.keys(b.affordances ?? {})])]
        .sort()
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
    // Travels with the numbers so it cannot be dropped in transcription.
    caveat: confounders.length
      ? `acknowledged confounders: ${confounders.map((c) => c.dimension).join(', ')}`
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
