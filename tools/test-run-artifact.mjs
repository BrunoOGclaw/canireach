// Fault-oriented tests for the publication gate.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArtifacts, validateRun, verifyArtifacts } from './finalize-run.mjs';
import { INSTRUMENT_POLICY } from './policy.mjs';

const RUN = '2026-08-22-slot0417-gh1a1';
const VANTAGE = 'github-actions-ubuntu-dynamic';
const DIALECTS = ['browser', 'curl', 'canireach', 'gptbot', 'claudebot'];
const FILES = ['robots', 'llms_txt', 'agents_md', 'wellknown_agents', 'web_bot_auth'];

function fixtureRows() {
  const base = {
    schema_version: 2,
    ts: '2026-08-22T09:17:00.000Z',
    run: RUN,
    vantage: VANTAGE,
    rank: 1,
    domain: 'example.com',
  };
  return [
    ...DIALECTS.map((dialect) => ({
      ...base,
      kind: 'request',
      dialect,
      robots: { allowed: true, known: true },
      requested: true,
      outcome: 'reachable',
      status: 200,
    })),
    ...FILES.map((file) => ({ ...base, kind: 'file', file, status: 404, present: false })),
  ];
}

function makeCase(transform = (rows) => rows, raw = null) {
  const dir = mkdtempSync(join(tmpdir(), 'cir-artifact-'));
  const list = join(dir, 'domains.csv');
  const file = join(dir, `${RUN}.jsonl`);
  writeFileSync(list, '1,example.com\n');
  const rows = transform(fixtureRows());
  writeFileSync(file, raw ?? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  return { dir, list, file };
}

function mustFail(label, transform, raw = null) {
  const c = makeCase(transform, raw);
  assert.throws(() => validateRun(c.file, { run: RUN, list: c.list, vantage: VANTAGE }), undefined, label);
}

const good = makeCase();
const summary = validateRun(good.file, { run: RUN, list: good.list, vantage: VANTAGE });
assert.equal(summary.rows, 10);
assert.equal(summary.request_rows, 5);
assert.equal(summary.file_rows, 5);
assert.equal(summary.domains, 1);

mustFail('invalid JSON', (rows) => rows, '{not json}\n');
mustFail('mixed run IDs', (rows) => rows.map((row, i) => (i === 2 ? { ...row, run: 'other' } : row)));
mustFail('unknown request outcome', (rows) => rows.map((row, i) => (i === 0 ? { ...row, outcome: 'mystery' } : row)));
mustFail('missing row', (rows) => rows.slice(0, -1));
mustFail('duplicate identity', (rows) => [...rows.slice(0, -1), { ...rows[0] }]);
mustFail('forbidden response body', (rows) => rows.map((row, i) => (i === 0 ? { ...row, body: 'secret' } : row)));
mustFail('generic headers map', (rows) => rows.map((row, i) => (i === 0 ? { ...row, headers: { server: 'x' } } : row)));
mustFail('unapproved row key', (rows) => rows.map((row, i) => (i === 0 ? { ...row, arbitrary_header_value: 'x' } : row)));
mustFail('unapproved toll key', (rows) => rows.map((row, i) => (
  i === 0 ? { ...row, toll: { status_402: false, arbitrary_header_value: 'x' } } : row
)));
mustFail('credential-shaped value', (rows) => rows.map((row, i) => (
  i === 0 ? { ...row, server: ['ghp', '123456789012345678901234'].join('_') } : row
)));
mustFail('robots bypass', (rows) => rows.map((row, i) => (i === 0 ? { ...row, robots: { allowed: false }, requested: true } : row)));
mustFail('old toll headers schema', (rows) => rows.map((row, i) => (i === 0 ? { ...row, toll: { headers: ['crawler-price'] } } : row)));

const artifacts = createArtifacts(
  good.file,
  { run: RUN, list: good.list, vantage: VANTAGE },
  {
    scheduled_slot: '2026-08-22T04:17:00-05:00[America/Chicago]',
    instrument_sha: 'a'.repeat(40),
    repository: 'owner/repo',
    workflow_run_id: '1',
    workflow_run_attempt: '1',
    workflow_url: 'https://github.com/owner/repo/actions/runs/1',
    runner_os: 'Linux',
    runner_arch: 'X64',
    runner_image: 'ubuntu-24.04',
  },
);
assert.equal(artifacts.manifest.capture_id, RUN);
assert.equal(artifacts.manifest.dataset.sha256, summary.sha256);
verifyArtifacts(good.file, { run: RUN, list: good.list, vantage: VANTAGE });
verifyArtifacts(
  good.file,
  { run: RUN, list: good.list, vantage: VANTAGE },
  { instrument_sha: 'a'.repeat(40), repository: 'owner/repo', workflow_run_id: '1', workflow_run_attempt: '1' },
);
assert.throws(
  () => verifyArtifacts(
    good.file,
    { run: RUN, list: good.list, vantage: VANTAGE },
    { instrument_sha: 'b'.repeat(40) },
  ),
  /instrument commit mismatch/,
  'publisher must reject a manifest from a different instrument SHA',
);
assert.throws(
  () => createArtifacts(good.file, { run: RUN, list: good.list, vantage: VANTAGE }, {}),
  /sidecar already exists/,
  'sidecars are immutable',
);

// The manifest now carries the two things a future comparison depends on: the
// derived numbers, and the comparability profile of the instrument that produced
// them. Both are re-derived on the verify pass, so neither can be hand-edited
// between capture and publication — the shape that would let a release assert a
// number nobody can regenerate from its own bytes.
const manifestPath = join(good.dir, `${RUN}.manifest.json`);
const published = JSON.parse(readFileSync(manifestPath, 'utf8'));
assert.ok(published.aggregates?.outcomes, 'manifest must carry derived aggregates');
assert.equal(published.aggregates.rows, summary.rows, 'manifest aggregates must describe this dataset');
assert.deepEqual(published.instrument_policy, INSTRUMENT_POLICY);

// ...and WHEN it looked. Everything in the profile above describes how the
// instrument was configured; the slot is the only dimension that says which hour
// the observations came from, and without it two captures fourteen hours apart
// compared as strictly comparable.
assert.equal(published.observation_window?.slot, '04:17[America/Chicago]', 'manifest must carry the slot');
assert.equal(typeof published.observation_window.drift_minutes, 'number', 'and the slip from it');

for (const [label, mutate, pattern] of [
  ['hand-edited aggregate', (m) => { m.aggregates.outcomes.reachable = (m.aggregates.outcomes.reachable ?? 0) + 1; }, /aggregates are not reproducible/],
  ['drifted comparability profile', (m) => { m.instrument_policy = { ...m.instrument_policy, robots_unavailable: 'fail-open' }; }, /instrument policy does not match/],
  // A dimension that can be edited between capture and publication is not a
  // control. Editing the slot is how a daytime capture would be dressed up as a
  // nightly one, and it is the single edit that would re-open the pairing this
  // dimension exists to block.
  ['relabelled observation slot', (m) => { m.observation_window = { ...m.observation_window, slot: '00:00[UTC]' }; }, /observation window is not reproducible/],
  ['adjusted schedule drift', (m) => { m.observation_window = { ...m.observation_window, drift_minutes: (m.observation_window.drift_minutes ?? 0) + 7 }; }, /observation window is not reproducible/],
]) {
  const tampered = JSON.parse(JSON.stringify(published));
  mutate(tampered);
  writeFileSync(manifestPath, `${JSON.stringify(tampered, null, 2)}\n`);
  assert.throws(
    () => verifyArtifacts(good.file, { run: RUN, list: good.list, vantage: VANTAGE }),
    pattern,
    `publisher must reject a ${label}`,
  );
}
// Restored: the gate goes green again on the untampered manifest, so the two
// rejections above are the gate working and not a permanently red check.
writeFileSync(manifestPath, `${JSON.stringify(published, null, 2)}\n`);
verifyArtifacts(good.file, { run: RUN, list: good.list, vantage: VANTAGE });

writeFileSync(join(good.dir, `${RUN}.sha256`), 'wrong\n');
assert.throws(
  () => verifyArtifacts(good.file, { run: RUN, list: good.list, vantage: VANTAGE }),
  /checksum sidecar mismatch/,
);

const mismatchedName = join(good.dir, 'different.jsonl');
writeFileSync(mismatchedName, readFileSync(good.file));
assert.throws(
  () => validateRun(mismatchedName, { run: RUN, list: good.list, vantage: VANTAGE }),
  /filename does not match run identity/,
);

const partial = join(good.dir, `${RUN}.jsonl.partial`);
writeFileSync(partial, readFileSync(good.file));
assert.equal(
  validateRun(partial, { run: RUN, list: good.list, vantage: VANTAGE, allowPartial: true }).rows,
  10,
  'a complete partial can pass immediately before atomic rename',
);
assert.throws(
  () => validateRun(partial, { run: RUN, list: good.list, vantage: VANTAGE }),
  /filename does not match run identity/,
  'a partial is never publishable as a final artifact',
);

console.log('run artifact gate: 10-row positive control and 16 fault paths passed');
