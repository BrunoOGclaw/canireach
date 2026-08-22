#!/usr/bin/env node

// The nightly's series step, EXECUTED.
//
// test-series.mjs proves the partner rule and the comparison. This proves the
// twenty lines of workflow shell that stand between them and reality: the
// exit-code mapping. Getting that wrong has a specific and ugly failure mode —
// a withheld delta reported as a broken job, or worse, a comparison that never
// reached the gate reported as success. The whole point of the gate is that
// those three states stay distinguishable, and the shell is where they are
// distinguished.
//
// Shipping this untested would repeat, in the same file, the defect that
// test-preflight.mjs exists to close.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertExtracted, extractRunScript } from './workflow-step.mjs';

const STEP_NAME = 'Compare against the previous capture in this slot';
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const workflowPath = join(repoRoot, '.github/workflows/nightly-baseline.yml');

const script = extractRunScript(readFileSync(workflowPath, 'utf8'), STEP_NAME);
assertExtracted(script, [
  'set -euo pipefail',
  'tools/series.mjs select',
  'tools/series.mjs compare',
  'gh release download',
  'GITHUB_STEP_SUMMARY',
  'verdict=',
], 'series step');

const root = mkdtempSync(join(tmpdir(), 'canireach-series-step-'));
const binDir = join(root, 'bin');
mkdirSync(binDir);

const SLOT = '04:17[America/Chicago]';
const tagFor = (date, run) => `baseline-${date}-slot0417-America_Chicago-schedule-gh${run}a1`;
const published = (tag, createdAt) => ({ tagName: tag, createdAt, isDraft: false, isImmutable: true });

function manifest(captureId, { slot = SLOT, reachable = 2400, policy = {} } = {}) {
  return {
    capture_id: captureId,
    observed_from: '2026-08-24T09:19:00Z',
    instrument_commit: 'a'.repeat(40),
    observation_window: { slot, nominal: null, observed_local: '04:19', drift_minutes: 2 },
    vantage: { class: 'github-actions-dynamic' },
    input: { sha256: 'b'.repeat(64) },
    instrument_policy: {
      row_schema_version: 2,
      robots_unavailable: 'fail-closed-except-404-410',
      redirects: 'not-followed',
      denial_gate: 'no-request-past-a-denial',
      dialects: ['browser', 'canireach', 'claudebot', 'curl', 'gptbot'],
      ...policy,
    },
    aggregates: { domains: 1000, requests_sent: 5000, outcomes: { reachable }, challenges: {}, toll: {}, affordances: {} },
  };
}

/**
 * `gh` is stubbed so no case can reach the network, and so a case cannot pass
 * because a real gh answered. `release download` writes the manifest the
 * scenario declares, keyed by tag — which is exactly the coupling the step's
 * tag/manifest check exists to police, so a scenario can put them in conflict.
 */
writeFileSync(
  join(binDir, 'gh'),
  [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$*" >> "$GH_STUB_LOG"',
    'case "$1 $2" in',
    '  "release list")',
    '    cat "$GH_STUB_RELEASES"; exit 0 ;;',
    '  "release download")',
    '    tag=$3',
    '    dir=""',
    '    while [ $# -gt 0 ]; do [ "$1" = --dir ] && dir=$2; shift; done',
    '    [ -f "$GH_STUB_MANIFESTS/$tag.json" ] || { echo "no such release: $tag" >&2; exit 1; }',
    '    mkdir -p "$dir"',
    '    cp "$GH_STUB_MANIFESTS/$tag.json" "$dir/${tag#baseline-}.manifest.json"',
    '    exit 0 ;;',
    'esac',
    'echo "unstubbed gh: $*" >&2; exit 90',
  ].join('\n'),
  { mode: 0o755 },
);
chmodSync(join(binDir, 'gh'), 0o755);

let n = 0;

function runStep({ captureId, releases, manifests, rawReleases = null }) {
  n += 1;
  const dir = join(root, `case${n}`);
  mkdirSync(dir);
  // The step runs `node tools/...` from the checkout root.
  cpSync(join(repoRoot, 'tools'), join(dir, 'tools'), { recursive: true });

  const manifestDir = join(dir, 'manifests');
  mkdirSync(manifestDir);
  for (const [tag, m] of Object.entries(manifests)) {
    writeFileSync(join(manifestDir, `${tag}.json`), JSON.stringify(m, null, 2));
  }
  const releasesPath = join(dir, 'releases.fixture.json');
  writeFileSync(releasesPath, rawReleases ?? JSON.stringify(releases, null, 2));

  const outputs = join(dir, 'github_output');
  const summary = join(dir, 'github_step_summary');
  const ghLog = join(dir, 'gh.log');
  for (const f of [outputs, summary, ghLog]) writeFileSync(f, '');

  let status = 0;
  let stderr = '';
  try {
    execFileSync('bash', ['-c', script], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: `${binDir}:${process.env.PATH}`,
        HOME: dir,
        CAPTURE_ID: captureId,
        GITHUB_REPOSITORY: 'BrunoOGclaw/canireach',
        GITHUB_OUTPUT: outputs,
        GITHUB_STEP_SUMMARY: summary,
        GH_TOKEN: 'stub-token-not-a-credential',
        GH_STUB_LOG: ghLog,
        GH_STUB_RELEASES: releasesPath,
        GH_STUB_MANIFESTS: manifestDir,
      },
    });
  } catch (err) {
    status = err.status;
    stderr = String(err.stderr ?? '');
  }
  const kv = Object.fromEntries(
    readFileSync(outputs, 'utf8').split('\n').filter(Boolean).map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }),
  );
  return {
    status,
    stderr,
    verdict: kv.verdict,
    summary: readFileSync(summary, 'utf8'),
    ghCalls: readFileSync(ghLog, 'utf8').split('\n').filter(Boolean),
    comparison: (() => {
      try {
        return JSON.parse(readFileSync(join(dir, 'comparison.json'), 'utf8'));
      } catch {
        return null;
      }
    })(),
  };
}

const tonight = tagFor('2026-08-23', 900);
const lastNight = tagFor('2026-08-22', 800);

// --- the first night in a slot: normal, and must not read as a failure -----

{
  const r = runStep({
    captureId: tonight.replace('baseline-', ''),
    releases: [published(tonight, '2026-08-23T09:20:00Z'), { tagName: 'baseline-2026-08-22T162332Z-manual-gh5a1', createdAt: '2026-08-22T16:23:00Z', isDraft: false, isImmutable: true }],
    manifests: {},
  });
  assert.equal(r.status, 0, `the first night in a slot must exit 0: ${r.stderr}`);
  assert.equal(r.verdict, 'no-partner');
  assert.match(r.summary, /No series partner yet: no prior published capture in slot 04:17\[America\/Chicago\]/);
  // It stops before downloading anything: there is nothing to download, and a
  // step that pressed on would have to invent a partner.
  assert.equal(r.ghCalls.filter((c) => c.startsWith('release download')).length, 0);
  assert.equal(r.comparison, null);
}

// --- a released delta ------------------------------------------------------

{
  const captureId = tonight.replace('baseline-', '');
  const r = runStep({
    captureId,
    releases: [published(tonight, '2026-08-23T09:20:00Z'), published(lastNight, '2026-08-22T09:20:00Z')],
    manifests: {
      [tonight]: manifest(captureId, { reachable: 2000 }),
      [lastNight]: manifest(lastNight.replace('baseline-', ''), { reachable: 2400 }),
    },
  });
  assert.equal(r.status, 0, `a comparable pair must exit 0: ${r.stderr}`);
  assert.equal(r.verdict, 'delta');
  assert.equal(r.comparison.comparison.delta.outcomes.reachable.change, -400);
  assert.match(r.summary, /Verdict: \*\*delta\*\*/);
  assert.match(r.summary, new RegExp(lastNight));
  assert.equal(r.ghCalls.filter((c) => c.startsWith('release download')).length, 2, 'both sides come from the published releases');
}

// --- withheld is a finding, not a broken job ------------------------------

{
  const captureId = tonight.replace('baseline-', '');
  const r = runStep({
    captureId,
    releases: [published(tonight, '2026-08-23T09:20:00Z'), published(lastNight, '2026-08-22T09:20:00Z')],
    manifests: {
      [tonight]: manifest(captureId, { policy: { robots_unavailable: 'fail-open' } }),
      [lastNight]: manifest(lastNight.replace('baseline-', '')),
    },
  });
  assert.equal(r.status, 0, 'a withheld delta must not fail the job');
  assert.equal(r.verdict, 'withheld');
  assert.equal(r.comparison.comparison.delta, null, 'withheld means no number was emitted');
  assert.match(r.comparison.comparison.withheld_reason, /robots_unavailable/);
}

// --- could-not-perform must be loud ---------------------------------------

{
  // The tag says 04:17 and the manifest says otherwise: the partner was chosen
  // on a filename. This is the one case that must go red, because unlike a
  // withheld delta it means the gate was never reached.
  const captureId = tonight.replace('baseline-', '');
  const r = runStep({
    captureId,
    releases: [published(tonight, '2026-08-23T09:20:00Z'), published(lastNight, '2026-08-22T09:20:00Z')],
    manifests: {
      [tonight]: manifest(captureId),
      [lastNight]: manifest(lastNight.replace('baseline-', ''), { slot: '05:17[America/Chicago]' }),
    },
  });
  assert.notEqual(r.status, 0, 'a comparison that could not be performed must fail the job');
  assert.equal(r.verdict, 'could-not-perform');
  assert.match(r.stderr, /refusing to difference on a filename/);
}

{
  // A partner that cannot be downloaded is infrastructure failure, not a
  // finding, and `set -euo pipefail` must carry it out rather than let the step
  // continue into a comparison with no data.
  const captureId = tonight.replace('baseline-', '');
  const r = runStep({
    captureId,
    releases: [published(tonight, '2026-08-23T09:20:00Z'), published(lastNight, '2026-08-22T09:20:00Z')],
    manifests: { [tonight]: manifest(captureId) },
  });
  assert.notEqual(r.status, 0, 'an undownloadable partner must fail the job');
  assert.notEqual(r.verdict, 'delta');
}

{
  // Selection failing for any reason OTHER than "no partner yet" is
  // infrastructure failure. Without this case the step could ignore every
  // non-zero select exit and still look tested: fault injection escaped here
  // until it was added, because only exit 4 was ever exercised.
  const captureId = tonight.replace('baseline-', '');
  const r = runStep({
    captureId,
    releases: [],
    rawReleases: '{ not json',
    manifests: { [tonight]: manifest(captureId) },
  });
  // Exactly 2, not merely non-zero. Without the guard the step blunders on and
  // fails later inside `gh release download ""` — still red, but reporting "no
  // such release" for a selection that never happened. This whole file exists
  // because the exit code IS the contract, so asserting only "it went red" would
  // let the mapping rot while the test stayed green. It did: this assertion is
  // what turned that mutant from ESCAPED into CAUGHT.
  assert.equal(r.status, 2, 'an unreadable release list must surface as could-not-perform');
  assert.equal(r.verdict, undefined, 'a step that could not select must not publish a verdict');
}

rmSync(root, { recursive: true, force: true });
console.log(`series step: ${n} executions of the real workflow shell passed (no-partner, delta, withheld, could-not-perform kept distinct)`);
