#!/usr/bin/env node

// Tests for the series partner rule and the series comparison.
//
// The property under test is not "does it produce a delta" — `test-compare.mjs`
// owns that. It is "does it difference the RIGHT two captures, and does it
// refuse rather than guess when the selection cannot be trusted".

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectPartner, slotFromTag } from './series.mjs';
import { COMPARABILITY_DIMENSIONS, INSTRUMENT_POLICY, UNRECORDED, dimensionValue } from './policy.mjs';

const TOOL = fileURLToPath(new URL('./series.mjs', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'canireach-series-'));

const published = (tag, createdAt, over = {}) => ({
  tagName: tag,
  createdAt,
  isDraft: false,
  isImmutable: true,
  ...over,
});
const slotTag = (date, run) => `baseline-${date}-slot0417-America_Chicago-schedule-gh${run}a1`;

// --- slot derivation -------------------------------------------------------

assert.equal(slotFromTag(slotTag('2026-08-23', 1)), '04:17[America/Chicago]');
assert.equal(slotFromTag('baseline-2026-08-23-slot2300-America_Chicago-schedule-gh1a1'), '23:00[America/Chicago]');
assert.equal(slotFromTag('baseline-2026-08-22T162332Z-manual-gh1a1'), null, 'a manual capture claims no slot');
assert.equal(slotFromTag('baseline-2026-08-22T0815Z'), null);
// A slot that is not a clock time is not a slot. Left unguarded, `slot2599`
// would compare equal to another `slot2599` and manufacture a series out of two
// malformed tags.
assert.equal(slotFromTag('baseline-2026-08-23-slot2599-America_Chicago-schedule-gh1a1'), null);
assert.equal(slotFromTag('baseline-2026-08-23-slot0460-America_Chicago-schedule-gh1a1'), null);

// --- the partner rule ------------------------------------------------------

const tonight = slotTag('2026-08-23', 900);
const lastNight = slotTag('2026-08-22', 800);
const twoNights = slotTag('2026-08-21', 700);

{
  // The trap this rule exists for: a hand-run verification dispatch is the
  // newest release when the scheduled capture publishes. Newest-prior would pick
  // it, the observation-window gate would correctly withhold, and the real
  // night-over-night delta would never be computed.
  const pair = selectPartner(
    [
      published(tonight, '2026-08-23T09:20:00Z'),
      published('baseline-2026-08-22T162332Z-manual-gh5a1', '2026-08-22T16:23:00Z'),
      published(lastNight, '2026-08-22T09:20:00Z'),
    ],
    tonight,
  );
  assert.equal(pair.partner.tag, lastNight, 'a midday manual dispatch must not become the series partner');
  assert.equal(pair.current_slot, '04:17[America/Chicago]');
  const manualRow = pair.considered.find((c) => c.tag.includes('manual'));
  assert.equal(manualRow.skipped, `different slot (${UNRECORDED})`);
  // Every rejection is published with its reason: the selection has to be
  // auditable without rerunning it, or the rule becomes a claim about itself.
  assert.equal(pair.considered.length, 3);
  assert.equal(pair.considered.filter((c) => c.skipped === null).length, 1);
}

{
  const pair = selectPartner(
    [published(tonight, '2026-08-23T09:20:00Z'), published(lastNight, '2026-08-22T09:20:00Z'), published(twoNights, '2026-08-21T09:20:00Z')],
    tonight,
  );
  assert.equal(pair.partner.tag, lastNight, 'the MOST RECENT prior same-slot capture wins');
}

{
  // Tonight's actual situation, and the first thing this job will report: the
  // slot exists, nothing precedes it in that slot, and that is not an error.
  const pair = selectPartner(
    [
      published(tonight, '2026-08-23T09:20:00Z'),
      published('baseline-2026-08-22T162332Z-manual-gh5a1', '2026-08-22T16:23:00Z'),
      published('baseline-2026-08-22T0815Z', '2026-08-22T08:43:09Z'),
    ],
    tonight,
  );
  assert.equal(pair.partner, null);
  assert.match(pair.reason, /no prior published capture in slot 04:17\[America\/Chicago\]/);
}

{
  // The immutable pre-automation baseline must never be pulled into the
  // automated series unattended. Differencing the launch claim against it is a
  // deliberate acknowledged act, not a nightly job's decision.
  const pair = selectPartner(
    [published(tonight, '2026-08-23T09:20:00Z'), published('baseline-2026-08-22T0815Z', '2026-08-22T08:43:09Z')],
    tonight,
  );
  assert.equal(pair.partner, null, 'the v1 baseline is not reachable by the nightly rule');
}

{
  const manual = 'baseline-2026-08-22T162332Z-manual-gh5a1';
  const pair = selectPartner([published(manual, '2026-08-22T16:23:00Z'), published(lastNight, '2026-08-22T09:20:00Z')], manual);
  assert.equal(pair.partner, null, 'a hand-run capture has no series to be part of');
  assert.equal(pair.current_slot, UNRECORDED);
  assert.match(pair.reason, /no repeatable slot/);
  assert.deepEqual(pair.considered, [], 'nothing is even considered for a capture with no slot');
}

{
  // A half-published release is not a citable artifact. A delta against a
  // mutable release could stop being reproducible the moment its assets change.
  for (const [label, over] of [['draft', { isDraft: true }], ['mutable', { isImmutable: false }]]) {
    const pair = selectPartner(
      [published(tonight, '2026-08-23T09:20:00Z'), published(lastNight, '2026-08-22T09:20:00Z', over), published(twoNights, '2026-08-21T09:20:00Z')],
      tonight,
    );
    assert.equal(pair.partner.tag, twoNights, `a ${label} release must be skipped, not differenced against`);
  }
}

{
  const pair = selectPartner(
    [published(tonight, '2026-08-23T09:20:00Z'), published(slotTag('2026-08-24', 950), '2026-08-24T09:20:00Z')],
    tonight,
  );
  assert.equal(pair.partner, null, 'a LATER capture is not a prior capture');
}

{
  // The three tags of the v1 baseline share a creation timestamp to the second.
  // An unstable sort would make the partner depend on API ordering, and a delta
  // whose inputs depend on list order is not reproducible.
  const a = slotTag('2026-08-22', 801);
  const b = slotTag('2026-08-22', 802);
  const forward = selectPartner([published(tonight, '2026-08-23T09:20:00Z'), published(a, '2026-08-22T09:20:00Z'), published(b, '2026-08-22T09:20:00Z')], tonight);
  const reversed = selectPartner([published(tonight, '2026-08-23T09:20:00Z'), published(b, '2026-08-22T09:20:00Z'), published(a, '2026-08-22T09:20:00Z')], tonight);
  assert.equal(forward.partner.tag, reversed.partner.tag, 'ties must not depend on input order');
  assert.equal(forward.partner.tag, b);
}

// --- end to end, through the CLI, on manifests -----------------------------

function manifest(tag, slot, { outcomes, aggregates = true } = {}) {
  const m = {
    capture_id: tag.replace('baseline-', ''),
    observed_from: '2026-08-23T09:19:00Z',
    instrument_commit: 'a'.repeat(40),
    observation_window: { slot, nominal: null, observed_local: '09:19', drift_minutes: 2 },
    vantage: { class: 'github-actions-dynamic' },
    input: { sha256: 'b'.repeat(64) },
    // Derived, not hand-listed. A fixture that spells out the policy block goes
    // stale the moment a dimension is added — and it goes stale in the most
    // dangerous direction: both sides report `unrecorded`, which never equals
    // anything, so every pair is withheld and a suite whose cases all expect a
    // delta turns red while a suite that expected withholding would have gone
    // GREEN while testing nothing at all.
    instrument_policy: { ...INSTRUMENT_POLICY },
  };
  if (aggregates) {
    m.aggregates = { domains: 1000, requests_sent: 5000, outcomes, challenges: {}, toll: {}, affordances: {} };
  }
  return m;
}

// A fixture that is missing a declared dimension can only ever produce
// `withheld`, so a case expecting a delta would fail for a reason that has
// nothing to do with what it tests. Checked once, here, rather than diagnosed
// later from a confusing withheld_reason.
for (const path of COMPARABILITY_DIMENSIONS) {
  assert.notEqual(
    dimensionValue(manifest('baseline-x', '04:17[America/Chicago]', { outcomes: {} }), path),
    UNRECORDED,
    `the comparison fixture does not record ${path}, so every pair built from it is withheld by construction`,
  );
}

let files = 0;
const write = (obj) => {
  files += 1;
  const p = join(root, `f${files}.json`);
  writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
};

function run(args) {
  try {
    const stdout = execFileSync('node', [TOOL, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
  }
}

const releasesPath = write([
  published(tonight, '2026-08-23T09:20:00Z'),
  published(lastNight, '2026-08-22T09:20:00Z'),
]);
const pairPath = join(root, 'pair.json');
assert.equal(run(['select', '--releases', releasesPath, '--current-tag', tonight, '--out', pairPath]).code, 0);
assert.equal(JSON.parse(readFileSync(pairPath, 'utf8')).partner.tag, lastNight);

// No partner is exit 4 — distinguishable from both "withheld" and "could not
// run", because the workflow must treat the first night in a slot as normal.
const lonely = run(['select', '--releases', write([published(tonight, '2026-08-23T09:20:00Z')]), '--current-tag', tonight, '--out', join(root, 'lonely.json')]);
assert.equal(lonely.code, 4);
assert.match(lonely.stderr, /no series partner/);

const slot = '04:17[America/Chicago]';
const priorM = write(manifest(lastNight, slot, { outcomes: { reachable: 2500, error: 100 } }));
const currentM = write(manifest(tonight, slot, { outcomes: { reachable: 2000, error: 600 } }));

const good = run(['compare', '--pair', pairPath, '--prior-manifest', priorM, '--current-manifest', currentM]);
assert.equal(good.code, 0, `expected a released delta, got ${good.code}: ${good.stderr}`);
const out = JSON.parse(good.stdout);
assert.equal(out.comparison.strictly_comparable, true);
assert.equal(out.comparison.delta.outcomes.reachable.change, -500);
// Compared EXACTLY, now that `delta()` rounds the change at the precision of the
// sides it was computed from. This assertion used to carry a 1e-9 tolerance
// because the same subtraction arrived as -0.09999999999999998 — the noise the
// tolerance was hiding is the defect #29 removed, and a tolerance here would go
// on passing if it came back.
assert.equal(out.comparison.delta.reachable_rate_of_sent.change, -0.1);
assert.equal(out.selection.partner.tag, lastNight);

{
  // The vacuity guard for everything above: the gate must be capable of
  // withholding on this same path, or "comparable" is not a finding.
  const drifted = write({
    ...manifest(tonight, slot, { outcomes: { reachable: 2000 } }),
    instrument_policy: { ...manifest(tonight, slot, { outcomes: {} }).instrument_policy, robots_unavailable: 'fail-open' },
  });
  const withheld = run(['compare', '--pair', pairPath, '--prior-manifest', priorM, '--current-manifest', drifted]);
  assert.equal(withheld.code, 3, 'a policy change must withhold, not emit');
  assert.match(withheld.stderr, /withheld/);
  assert.equal(JSON.parse(withheld.stdout).comparison.delta, null);
}

{
  // The tag chose the partner; if the manifest disagrees, the selection was made
  // on a filename. Refuse rather than difference on it.
  const mislabelled = write(manifest(lastNight, '05:17[America/Chicago]', { outcomes: { reachable: 2500 } }));
  const r = run(['compare', '--pair', pairPath, '--prior-manifest', mislabelled, '--current-manifest', currentM]);
  assert.equal(r.code, 2, 'tag/manifest slot drift must be "could not perform", not a delta');
  assert.match(r.stderr, /refusing to difference on a filename/);
}
{
  const mislabelled = write(manifest(tonight, UNRECORDED, { outcomes: { reachable: 2000 } }));
  const r = run(['compare', '--pair', pairPath, '--prior-manifest', priorM, '--current-manifest', mislabelled]);
  assert.equal(r.code, 2, 'a current capture whose manifest lost its slot must refuse');
}

{
  // Could-not-perform must never be confused with withheld: one is the gate
  // holding, the other is the gate never reached.
  assert.equal(run(['compare', '--pair', pairPath, '--prior-manifest', join(root, 'nope.json'), '--current-manifest', currentM]).code, 2);
  assert.equal(run(['compare', '--pair', join(root, 'lonely.json'), '--prior-manifest', priorM, '--current-manifest', currentM]).code, 2);
  assert.equal(run(['select', '--releases', releasesPath]).code, 2);
  assert.equal(run(['nonsense']).code, 2);
}

{
  // A manifest with no aggregates block is admissible only through its own
  // verified bytes — the v1 path. Here the bytes are absent, so it must refuse
  // rather than silently difference against an empty aggregate.
  const v1 = write({ ...manifest(lastNight, slot, { outcomes: {}, aggregates: false }), dataset: { name: 'gone.jsonl', sha256: createHash('sha256').update('x').digest('hex'), rows: 1 } });
  const r = run(['compare', '--pair', pairPath, '--prior-manifest', v1, '--current-manifest', currentM]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /carries no aggregates/);
}

// A TRUNCATED CANDIDATE LIST IS NOT AN EMPTY ONE.
//
// `gh release list --limit N` is newest-first. If the partner has aged off the end
// of that window, the selector finds nothing and says "no prior capture in this
// slot" — exit 4, which the nightly treats as the ordinary first night and passes
// silently. So a full window must refuse (exit 2) rather than report absence.
{
  const window = [published(tonight, '2026-08-23T09:20:00Z'), published('baseline-2026-08-22T0815Z', '2026-08-22T08:43:09Z')];

  // The same list, one item short of its limit, is a genuine absence: exit 4. This
  // is the control — without it the refusal below could be firing on any full list.
  const room = run(['select', '--releases', write(window), '--current-tag', tonight, '--releases-limit', '3', '--out', join(root, 'room.json')]);
  assert.equal(room.code, 4, 'a window with room to spare reports absence');

  const full = run(['select', '--releases', write(window), '--current-tag', tonight, '--releases-limit', '2', '--out', join(root, 'full.json')]);
  assert.equal(full.code, 2, 'a full window cannot tell absence from truncation');
  assert.match(full.stderr, /limit/);

  // A full window that DID find a partner is unaffected: truncation only matters
  // when the answer was "nothing found".
  const found = run(['select', '--releases', write([published(tonight, '2026-08-23T09:20:00Z'), published(lastNight, '2026-08-22T09:20:00Z')]), '--current-tag', tonight, '--releases-limit', '2', '--out', join(root, 'found.json')]);
  assert.equal(found.code, 0);

  // A hand-run capture claims no repeatable slot, and no number of extra
  // candidates would give it one. That refusal must stay exit 4 even on a full
  // window, or every manual dispatch starts failing its own series step.
  const manualTag = 'baseline-2026-08-22T162332Z-manual-gh5a1';
  const manual = run(['select', '--releases', write([published(manualTag, '2026-08-22T16:23:00Z'), published(lastNight, '2026-08-22T09:20:00Z')]), '--current-tag', manualTag, '--releases-limit', '2', '--out', join(root, 'manual.json')]);
  assert.equal(manual.code, 4, 'a slotless capture is refused for its slot, not for the window');

  // Omitting the flag preserves the old behaviour exactly, so a caller that does
  // not know its own limit is never given a refusal it cannot act on.
  const unbounded = run(['select', '--releases', write(window), '--current-tag', tonight, '--out', join(root, 'unbounded.json')]);
  assert.equal(unbounded.code, 4);

  // A limit that is not a positive integer is REFUSED, not coerced. `Number('lots')`
  // is NaN and would silently disarm the guard while the caller believed it armed.
  for (const bad of ['lots', '0', '-1', '2.5']) {
    const r = run(['select', '--releases', write(window), '--current-tag', tonight, '--releases-limit', bad, '--out', join(root, `bad-${bad}.json`)]);
    assert.equal(r.code, 2, `--releases-limit ${bad} must refuse`);
    assert.match(r.stderr, /positive integer/);
  }
}

rmSync(root, { recursive: true, force: true });
console.log('series: partner rule (slot-matched, prior, immutable, deterministic) and refusal-over-guess passed');
