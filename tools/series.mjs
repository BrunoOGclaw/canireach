// The night-over-night series: choosing what a capture is compared against, and
// comparing it.
//
// `compare.mjs` answers "may these two captures be differenced?". It does not
// answer "which two?", and that second question is where a comparison quietly
// stops being about the web. Two traps in particular:
//
//   1. NEWEST-PRIOR IS THE WRONG PARTNER. A verification dispatch run by hand at
//      midday is the newest release when the 04:17 capture publishes. Differencing
//      against it compares 04:17 to lunchtime, which the observation-window gate
//      correctly withholds — so the real night-over-night delta never gets
//      computed at all, and the series looks alive while measuring nothing. Two
//      such dispatches already happened on the first day.
//
//   2. THE SELECTION RULE IS ITSELF A RESULT. A rule that ranged over candidates
//      until one produced a releasable delta would be choosing the answer. So the
//      rule is mechanical, fixed, and every candidate it rejected is published
//      with the reason — the partner is determined before any number is computed,
//      and a reader can audit the choice without rerunning anything.
//
// The rule: the most recent prior immutable, published capture in the SAME
// nominal slot. Ties on creation time break by tag, descending, so the choice is
// deterministic — the three tags of the v1 baseline share a creation timestamp
// to the second.
//
// The immutable pre-automation baseline is deliberately NOT reachable by this
// rule: it has no repeatable slot, and differencing the launch claim against it
// is an acknowledged, deliberate act at launch (`compare.mjs --acknowledge`), not
// something a nightly job should do unattended.
//
// The tag is a CANDIDATE FILTER, never the control. Tags and manifests are both
// derived from the workflow's `slot_date`, and a control derived from the same
// place as the thing it controls can drift from it silently. So the selected
// partner's manifest is re-read in `compare` mode and must agree with what its
// tag implied, or the comparison refuses rather than proceeding on the filename.
//
// A TRUNCATED CANDIDATE LIST IS NOT AN EMPTY ONE. The caller lists releases with
// `gh release list --limit N`, newest-first. If the partner has fallen off the end
// of that window, `selectPartner` finds nothing and says "no prior capture in this
// slot" — exit 4, which the nightly correctly treats as the ordinary state of the
// first night in a slot and passes silently. So a bound that is merely reached
// converts "I could not see the partner" into "there is no partner", and the
// series goes on looking alive while measuring nothing: trap 1 above, arriving
// through the release-list limit instead of through the selection rule. `--releases-limit`
// makes that distinguishable — a full window with no partner refuses (exit 2)
// instead of reporting absence.
//
// Usage:
//   node tools/series.mjs select  --releases R.json --current-tag TAG
//                                 [--releases-limit N] [--out F]
//   node tools/series.mjs compare --pair P.json --prior-manifest M.json
//                                 --current-manifest M.json [--prior-capture F]
//                                 [--current-capture F] [--out F]
// Exit codes: 0 done, 2 could not be performed, 3 delta withheld,
//             4 no partner exists yet.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadManifestAggregates } from './capture.mjs';
import { compareManifests } from './compare.mjs';
import { UNRECORDED } from './policy.mjs';

const COULD_NOT_PERFORM = 2;
const WITHHELD = 3;
const NO_PARTNER = 4;

const TAG_PREFIX = 'baseline-';

/**
 * The nominal slot a tag claims, or null for a capture that claims none.
 *
 * `baseline-2026-08-23-slot0417-America_Chicago-schedule-gh1a1` -> `04:17[America/Chicago]`,
 * spelled to match what `observationWindow` puts in the manifest so the two can
 * be compared directly rather than through a second translation.
 *
 * A tag cannot hold `/`, so the zone is written with underscores and read back
 * with a single substitution. That reconstruction is only exact for two-segment
 * zone names — the workflow emits `America_Chicago` and nothing else. A
 * three-segment zone would reconstruct wrongly, disagree with its own manifest,
 * and make `compare` refuse: wrong in the direction of not producing a number,
 * which is the correct direction for this project to be wrong in.
 */
export function slotFromTag(tag) {
  // `-` is the tag's own separator and must stay out of the zone charset: with
  // it included the greedy match ran past the zone and swallowed the trigger
  // token, yielding `America/Chicago-schedule` — a slot that would compare equal
  // only to another capture with the same trigger, quietly splitting one series
  // into two.
  const m = /-slot(\d{2})(\d{2})-([A-Za-z0-9_/]+)-/.exec(String(tag ?? ''));
  if (!m) return null;
  const [, hh, mm, zone] = m;
  if (Number(hh) > 23 || Number(mm) > 59) return null;
  return `${hh}:${mm}[${zone.replace(/_/g, '/')}]`;
}

/**
 * Pick the partner, and record why every other candidate was not it.
 *
 * `releases` is `gh release list --json tagName,createdAt,isDraft,isImmutable`.
 */
export function selectPartner(releases, currentTag) {
  const currentSlot = slotFromTag(currentTag);
  const current = releases.find((r) => r.tagName === currentTag) ?? null;

  const base = {
    current_tag: currentTag,
    current_slot: currentSlot ?? UNRECORDED,
    rule: 'most recent prior published immutable capture in the same nominal slot; ties broken by tag descending',
  };

  if (!currentSlot) {
    // A hand-run capture happened at whatever hour an operator ran it. Giving it
    // a series partner would manufacture a night-over-night reading out of two
    // unrelated moments.
    return { ...base, partner: null, reason: 'the current capture claims no repeatable slot', considered: [] };
  }

  const considered = [];
  const eligible = [];
  for (const r of releases) {
    const skip = (reason) => considered.push({ tag: r.tagName, skipped: reason });
    if (r.tagName === currentTag) { skip('is the current capture'); continue; }
    if (!String(r.tagName).startsWith(TAG_PREFIX)) { skip('not a capture release'); continue; }
    if (r.isDraft) { skip('draft'); continue; }
    // A mutable release is not yet a citable artifact; a delta against one could
    // stop being reproducible the moment its assets are replaced.
    if (!r.isImmutable) { skip('not immutable'); continue; }
    if (current && !(new Date(r.createdAt) < new Date(current.createdAt))) { skip('not earlier than the current capture'); continue; }
    const slot = slotFromTag(r.tagName);
    if (slot !== currentSlot) { skip(`different slot (${slot ?? UNRECORDED})`); continue; }
    considered.push({ tag: r.tagName, skipped: null });
    eligible.push(r);
  }

  eligible.sort((a, b) => {
    const t = new Date(b.createdAt) - new Date(a.createdAt);
    return t !== 0 ? t : (a.tagName < b.tagName ? 1 : a.tagName > b.tagName ? -1 : 0);
  });

  const partner = eligible[0] ?? null;
  return {
    ...base,
    partner: partner ? { tag: partner.tagName, created_at: partner.createdAt } : null,
    reason: partner ? null : `no prior published capture in slot ${currentSlot}`,
    considered,
  };
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read ${label} (${path}): ${err.message}`);
  }
}

function emit(value, out) {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  if (out) writeFileSync(out, json);
  else process.stdout.write(json);
}

function optreader(args) {
  return (name) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
  };
}

function doSelect(args) {
  const opt = optreader(args);
  const releasesPath = opt('--releases');
  const currentTag = opt('--current-tag');
  if (!releasesPath || !currentTag) {
    console.error('usage: node tools/series.mjs select --releases R.json --current-tag TAG [--out F]');
    return COULD_NOT_PERFORM;
  }
  const releases = readJson(releasesPath, 'release list');
  if (!Array.isArray(releases)) throw new Error('release list must be a JSON array');
  // Refused rather than coerced. `Number('lots')` is NaN and `Number(null)` is 0,
  // so a typo'd limit would quietly turn the truncation guard off and leave a
  // caller believing it was armed — the same reason compare.mjs throws on an
  // unrecognised --acknowledge instead of ignoring it.
  const limitRaw = opt('--releases-limit');
  let limit = null;
  if (limitRaw !== null) {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit <= 0) {
      console.error(`--releases-limit must be a positive integer, got: ${limitRaw}`);
      return COULD_NOT_PERFORM;
    }
  }
  const pair = selectPartner(releases, currentTag);
  const out = opt('--out');
  // `--print-tag` exists so a caller does not have to parse the pair file with a
  // second inline program. Untested shell in a workflow is how this project's
  // one never-executed branch stayed never-executed.
  if (args.includes('--print-tag')) {
    if (out) writeFileSync(out, `${JSON.stringify(pair, null, 2)}\n`);
    if (pair.partner) process.stdout.write(`${pair.partner.tag}\n`);
  } else {
    emit(pair, out);
  }
  if (!pair.partner) {
    // Only when the current capture HAD a slot: a hand-run capture is refused for
    // claiming no repeatable slot, which no amount of extra candidates would change.
    if (limit !== null && releases.length >= limit && pair.current_slot !== UNRECORDED) {
      console.error(
        `no partner found, but the release list is at its ${limit}-item limit\n` +
          '  a full window cannot distinguish "no prior capture in this slot" from\n' +
          '  "the prior capture is older than the window"; refusing rather than reporting absence',
      );
      return COULD_NOT_PERFORM;
    }
    console.error(`no series partner: ${pair.reason}`);
    return NO_PARTNER;
  }
  return 0;
}

function doCompare(args) {
  const opt = optreader(args);
  const pairPath = opt('--pair');
  const priorManifest = opt('--prior-manifest');
  const currentManifest = opt('--current-manifest');
  if (!pairPath || !priorManifest || !currentManifest) {
    console.error('usage: node tools/series.mjs compare --pair P.json --prior-manifest M.json --current-manifest M.json [--prior-capture F] [--current-capture F] [--out F]');
    return COULD_NOT_PERFORM;
  }
  const pair = readJson(pairPath, 'pair');
  if (!pair.partner) throw new Error('pair names no partner; select exited 4 and compare must not have run');

  const prior = loadManifestAggregates(priorManifest, { capturePath: opt('--prior-capture') });
  const currentSide = loadManifestAggregates(currentManifest, { capturePath: opt('--current-capture') });

  // The tag chose this partner; the manifest has to agree. If they ever diverge,
  // the selection was made on a filename and the comparison must not proceed on
  // one — the tag would have become a control that drifted from the record.
  // A partner only exists when the current capture had a slot, so both
  // expectations are real slots here; there is no `unrecorded` branch to take.
  for (const [label, side, expected] of [
    ['partner', prior, slotFromTag(pair.partner.tag)],
    ['current', currentSide, pair.current_slot],
  ]) {
    const recorded = side.manifest?.observation_window?.slot ?? UNRECORDED;
    if (recorded !== expected) {
      throw new Error(
        `${label} tag and manifest disagree on the observation slot\n` +
          `  tag implies  ${expected ?? UNRECORDED}\n` +
          `  manifest says ${recorded}\n` +
          '  the partner was selected on the tag; refusing to difference on a filename',
      );
    }
  }

  const result = compareManifests(
    { ...prior.manifest, aggregates: prior.aggregates },
    { ...currentSide.manifest, aggregates: currentSide.aggregates },
    { aggregatesSource: { before: prior.source, after: currentSide.source } },
  );
  emit({ selection: pair, comparison: result }, opt('--out'));

  if (!result.comparable) {
    // Withholding is the gate working, not the job breaking. It is reported as a
    // finding so it cannot be confused with a comparison that could not run —
    // an exit code that never reached the gate still reads like the gate holding.
    console.error(`series delta withheld: ${result.withheld_reason}`);
    return WITHHELD;
  }
  return 0;
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'select') return doSelect(args);
  if (mode === 'compare') return doCompare(args);
  console.error('usage: node tools/series.mjs <select|compare> ...');
  return COULD_NOT_PERFORM;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(String(err.message || err));
      process.exit(COULD_NOT_PERFORM);
    });
}
