// Loading a published capture, and proving it is the one the manifest describes.
//
// WHY THIS IS ITS OWN FILE. Two tools now need the same guarantee — the site
// builder, which must never publish a figure that did not come from the bytes it
// cites, and the cross-capture comparison, which must be able to put the
// immutable pre-September-15 baseline on the `--before` side. That baseline's
// manifest is schema v1: it predates the `aggregates` block and is published as
// an immutable release, so it can never be regenerated in place. Recomputing its
// aggregates from its own bytes is the only way in, and it is safe for exactly
// one reason — the manifest publishes the SHA-256 of those bytes, so the
// recomputation can be tied to the published artifact rather than to whatever
// happens to be on this disk.
//
// Two tools implementing that check separately would be two chances to get it
// wrong, so there is one implementation and both import it.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { aggregate } from './aggregate.mjs';

/** Where a side's aggregates came from. Travels into compare output. */
export const PUBLISHED = 'published-manifest';
export const RECOMPUTED = 'recomputed-from-verified-bytes';

/**
 * Read the capture and prove it is the published artifact before any number
 * derived from it reaches a public page or a delta.
 */
export function loadVerifiedCapture(capturePath, manifestPath) {
  const bytes = readFileSync(capturePath);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return { ...verifyCaptureBytes(bytes, manifest, capturePath), manifest };
}

/** The hash check itself, split out so a caller holding a parsed manifest can reuse it. */
export function verifyCaptureBytes(bytes, manifest, capturePath = '<bytes>') {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const declared = manifest?.dataset?.sha256;
  if (!declared) {
    throw new Error(`manifest for ${capturePath} declares no dataset.sha256; refusing to publish its numbers`);
  }
  if (sha256 !== declared) {
    throw new Error(
      `capture bytes do not match the published manifest\n  computed ${sha256}\n  manifest ${declared}`,
    );
  }
  const rows = bytes
    .toString('utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  if (manifest.dataset.rows !== rows.length) {
    throw new Error(`manifest declares ${manifest.dataset.rows} rows; file holds ${rows.length}`);
  }
  return { rows, sha256 };
}

/**
 * Where the bytes for a manifest live.
 *
 * The manifest is DATA — it is read from a downloaded release — so it does not
 * get to name an arbitrary path on this filesystem. Only the basename of
 * `dataset.name` is used, resolved beside the manifest itself. An operator who
 * genuinely keeps the two apart passes the path explicitly.
 */
export function resolveCapturePath(manifestPath, manifest, explicit = null) {
  if (explicit) return explicit;
  const name = manifest?.dataset?.name;
  if (!name) {
    throw new Error(`${manifestPath} names no dataset.name; pass the capture path explicitly`);
  }
  return join(dirname(manifestPath), basename(String(name)));
}

/**
 * v1 manifests carry `request_outcomes` — the outcome counts as published on the
 * day of the release. When they are present, the recomputation must reproduce
 * them exactly.
 *
 * This is the part that makes recomputation more than a hash check. The hash
 * proves the bytes are the published bytes; this proves that today's aggregator,
 * reading them, still gets the numbers that were published beside them. If the
 * aggregator's counting rules ever drift, a delta built on the recomputed side
 * would silently be measuring that drift — which is the entire failure mode this
 * project's comparability gate exists to prevent, one layer down.
 */
export function crosscheckPublishedOutcomes(manifest, aggregates, manifestPath = '<manifest>') {
  const published = manifest?.request_outcomes;
  if (!published || typeof published !== 'object') return null;
  const recomputed = aggregates.outcomes ?? {};
  const keys = [...new Set([...Object.keys(published), ...Object.keys(recomputed)])].sort();
  const disagreements = keys
    .filter((k) => (published[k] ?? 0) !== (recomputed[k] ?? 0))
    .map((k) => `${k}: published ${published[k] ?? 0}, recomputed ${recomputed[k] ?? 0}`);
  if (disagreements.length) {
    throw new Error(
      `recomputed aggregates disagree with the outcome counts published in ${manifestPath}\n  ${disagreements.join('\n  ')}`,
    );
  }
  return keys.length;
}

/**
 * A manifest plus the aggregates for it, from the manifest when it carries them
 * and recomputed from verified bytes when it predates the block.
 *
 * The source is returned rather than inferred by the caller, because a reader of
 * a delta is entitled to know which side's numbers were regenerated today.
 */
export function loadManifestAggregates(manifestPath, { capturePath = null } = {}) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.aggregates) {
    return { manifest, aggregates: manifest.aggregates, source: PUBLISHED, capture_path: null };
  }

  const resolved = resolveCapturePath(manifestPath, manifest, capturePath);
  if (!existsSync(resolved)) {
    throw new Error(
      `${manifestPath} carries no aggregates and its capture is not beside it\n` +
        `  looked for ${resolved}\n` +
        `  download the published artifact, or pass --${'{side}'}-capture FILE`,
    );
  }
  const { rows, sha256 } = verifyCaptureBytes(readFileSync(resolved), manifest, resolved);
  const aggregates = aggregate(rows);
  crosscheckPublishedOutcomes(manifest, aggregates, manifestPath);
  return { manifest, aggregates, source: RECOMPUTED, capture_path: resolved, dataset_sha256: sha256 };
}
