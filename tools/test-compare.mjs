#!/usr/bin/env node
//
// Tests for the cross-capture gate. The property under test is not "does it
// subtract correctly" — it is "does it REFUSE to subtract when the instrument
// moved". Both halves are checked, because a gate that never opens is as
// useless as one that never closes, and a green suite proves neither on its own.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareManifests, compareAggregates } from './compare.mjs';
import { PUBLISHED, RECOMPUTED } from './capture.mjs';
import { INSTRUMENT_POLICY } from './policy.mjs';

const COMPARE = fileURLToPath(new URL('./compare.mjs', import.meta.url));

const aggregates = (over = {}) => ({
  rows: 20,
  domains: 2,
  requests_sent: 8,
  outcomes: { reachable: 4, challenged: 2, denied_by_robots: 2 },
  challenges: { 'cloudflare-challenge': 2 },
  toll: { status_402: 1 },
  affordances: { llms_txt: { checked: 2, present: 1 }, agents_md: { checked: 2, present: 0 } },
  ...over,
});

const manifest = (over = {}) => ({
  schema_version: 3,
  capture_id: '2026-08-23-slot0417-America_Chicago-schedule-gh1a1',
  observed_from: '2026-08-23T09:17:00.000Z',
  instrument_commit: 'a'.repeat(40),
  vantage: { id: 'github-actions-ubuntu-dynamic', class: 'github-hosted-dynamic-egress' },
  instrument_policy: INSTRUMENT_POLICY,
  input: { name: 'data/domains/tranco-74V8X-1000.csv', sha256: 'f'.repeat(64) },
  aggregates: aggregates(),
  ...over,
});

// --- the gate opens when the instrument held still ---------------------------

{
  const after = manifest({
    capture_id: '2026-08-24-slot0417-America_Chicago-schedule-gh2a1',
    aggregates: aggregates({
      outcomes: { reachable: 1, challenged: 5, denied_by_robots: 2 },
      challenges: { 'cloudflare-challenge': 4, datadome: 1 },
      affordances: { llms_txt: { checked: 2, present: 2 }, agents_md: { checked: 2, present: 0 } },
    }),
  });
  const result = compareManifests(manifest(), after);
  assert.equal(result.comparable, true);
  assert.equal(result.strictly_comparable, true);
  assert.deepEqual(result.confounders, []);
  assert.equal(result.caveat, null);

  // Vacuity guard: "a delta was produced" means nothing unless the numbers in it
  // are the right numbers. Every one of these is hand-computed from the fixtures.
  assert.equal(result.delta.outcomes.reachable.change, -3);
  assert.equal(result.delta.outcomes.challenged.change, 3);
  assert.equal(result.delta.reachable_rate_of_sent.before, 0.5);
  assert.equal(result.delta.reachable_rate_of_sent.after, 0.125);
  assert.equal(result.delta.reachable_rate_of_sent.change, -0.375);
  // A vendor that appears on only one night must still show up, as a change
  // from zero — a union, not an intersection.
  assert.equal(result.delta.challenges.datadome.change, 1);
  assert.equal(result.delta.affordances.llms_txt.change, 1);
  assert.equal(result.delta.affordances.agents_md.change, 0);
}

// A category that disappears is a finding, not an absence.
{
  const d = compareAggregates(
    { requests_sent: 4, outcomes: { reachable: 4 }, challenges: { datadome: 3 } },
    { requests_sent: 4, outcomes: { reachable: 4 }, challenges: {} },
  );
  assert.equal(d.challenges.datadome.change, -3);
}

// --- the gate closes on the discontinuity this project actually has ----------

{
  // The published baseline: residential vantage, robots failing OPEN.
  const before = manifest({
    capture_id: '2026-08-22T0815Z',
    vantage: { id: 'residential-static', class: 'residential-static-egress' },
    instrument_policy: { ...INSTRUMENT_POLICY, robots_unavailable: 'fail-open' },
  });
  const result = compareManifests(before, manifest());
  assert.equal(result.comparable, false);
  assert.equal(result.delta, null, 'a delta across a moved instrument must be withheld, not merely flagged');
  assert.match(result.withheld_reason, /vantage\.class/);
  assert.deepEqual(result.blocking_dimensions.sort(), [
    'instrument_policy.robots_unavailable',
    'vantage.class',
  ]);

  // Acknowledging opens the gate and attaches the confounders to the numbers.
  const ack = compareManifests(before, manifest(), {
    acknowledge: ['vantage.class', 'instrument_policy.robots_unavailable'],
  });
  assert.equal(ack.comparable, true);
  assert.equal(ack.strictly_comparable, false, 'an acknowledged confounder is still a confounder');
  assert.ok(ack.delta);
  assert.match(ack.caveat, /vantage\.class/);
  assert.match(ack.caveat, /robots_unavailable/);
  assert.equal(ack.confounders.length, 2);
  assert.ok(ack.confounders.every((c) => c.acknowledged));

  // A partial acknowledgement is not an acknowledgement.
  const partial = compareManifests(before, manifest(), { acknowledge: ['vantage.class'] });
  assert.equal(partial.comparable, false);
  assert.deepEqual(partial.blocking_dimensions, ['instrument_policy.robots_unavailable']);
}

// A manifest predating the profile blocks on every policy dimension: unknown is
// not the same as unchanged. This is what keeps the immutable v1/v2 baseline
// from being silently differenced against the automated series.
{
  const legacy = manifest({ schema_version: 2, instrument_policy: undefined });
  delete legacy.instrument_policy;
  const result = compareManifests(legacy, manifest());
  assert.equal(result.comparable, false);
  assert.ok(result.blocking_dimensions.includes('instrument_policy.redirects'));
  assert.ok(result.confounders.every((c) => (c.dimension.startsWith('instrument_policy') ? c.unrecorded : true)));
}

// Two unrecorded sides do not cancel out into a match.
{
  const bare = manifest({ vantage: { id: 'x' } });
  const result = compareManifests(bare, manifest({ vantage: { id: 'y' } }));
  assert.ok(result.blocking_dimensions.includes('vantage.class'));
}

// A different domain list is not a delta about the web.
{
  const result = compareManifests(manifest(), manifest({ input: { name: 'top-5000.csv', sha256: '0'.repeat(64) } }));
  assert.equal(result.comparable, false);
  assert.deepEqual(result.blocking_dimensions, ['input.sha256']);
}

// A misspelled dimension must not read as an acknowledgement.
assert.throws(
  () => compareManifests(manifest(), manifest(), { acknowledge: ['vantage.klass'] }),
  /unknown comparability dimension/,
);

// --- exit codes, because the CI gate reads the status, not the JSON ----------

{
  const dir = mkdtempSync(join(tmpdir(), 'canireach-compare-'));
  const write = (name, value) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(value, null, 2));
    return path;
  };
  const same = write('a.manifest.json', manifest());
  const moved = write('b.manifest.json', manifest({ vantage: { id: 'r', class: 'residential-static-egress' } }));
  const noAggregates = write('c.manifest.json', manifest({ aggregates: undefined }));

  const run = (...args) => spawnSync(process.execPath, [COMPARE, ...args], { encoding: 'utf8' });

  const good = run('--before', same, '--after', same);
  assert.equal(good.status, 0);
  assert.equal(JSON.parse(good.stdout).comparable, true);

  const withheld = run('--before', same, '--after', moved);
  assert.equal(withheld.status, 3, 'a withheld comparison must fail the caller, not just say so');
  assert.equal(JSON.parse(withheld.stdout).delta, null);

  const acked = run('--before', same, '--after', moved, '--acknowledge', 'vantage.class');
  assert.equal(acked.status, 0);
  assert.match(acked.stderr, /acknowledged confounders/);

  const missing = run('--before', same, '--after', noAggregates);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /names no dataset\.name/);

  assert.equal(run('--before', same).status, 2, 'missing arguments must be a usage error');
}

// --- the immutable v1 baseline must be able to ENTER the comparison ----------
//
// The pre-September-15 baseline is schema v1 published as an immutable release:
// no `aggregates` block, no vantage, no instrument policy, and no possibility of
// regenerating it in place. Before this, compare.mjs refused it structurally, so
// the one capture the entire before/after claim depends on could not be a
// `--before` side at all — and a structural refusal is indistinguishable, from
// the exit code alone, from the comparability gate doing its job.
//
// data/probes/ is gitignored, so these fixtures are built here rather than read
// from disk: a test that only runs on the author's laptop enforces nothing.
{
  const dir = mkdtempSync(join(tmpdir(), 'canireach-v1-'));

  // Rows in the v1 shape, hand-counted below. Two domains, one dialect that was
  // allowed and one that robots denied, so `requests_sent` and the outcome
  // counts are not the same number.
  const rows = [];
  for (const domain of ['a.example', 'b.example']) {
    rows.push({
      schema_version: 1,
      kind: 'request',
      domain,
      dialect: 'browser',
      requested: true,
      outcome: 'reachable',
      robots: { allowed: true },
    });
    rows.push({
      schema_version: 1,
      kind: 'request',
      domain,
      dialect: 'gptbot',
      requested: false,
      outcome: 'denied_by_robots',
      robots: { allowed: false, reason: 'disallow' },
    });
    rows.push({ schema_version: 1, kind: 'file', domain, file: 'robots', status: 200, present: true });
    rows.push({ schema_version: 1, kind: 'file', domain, file: 'llms_txt', status: 200, present: domain === 'a.example' });
  }
  const bytes = Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  const writeV1 = (name, over = {}, body = bytes) => {
    const capture = join(dir, `${name}.jsonl`);
    writeFileSync(capture, body);
    const manifestPath = join(dir, `${name}.manifest.json`);
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          schema_version: 1,
          capture_id: '2026-08-22T0815Z',
          capture_class: 'pre-2026-09-15-baseline',
          input: { name: 'data/domains/tranco-74V8X-1000.csv', sha256: 'f'.repeat(64) },
          dataset: {
            name: `${name}.jsonl`,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            rows: rows.length,
          },
          request_outcomes: { reachable: 2, denied_by_robots: 2 },
          ...over,
        },
        null,
        2,
      ),
    );
    return manifestPath;
  };

  const modern = join(dir, 'after.manifest.json');
  writeFileSync(modern, JSON.stringify(manifest({ input: { name: 'x', sha256: 'f'.repeat(64) } }), null, 2));

  const run = (...args) => spawnSync(process.execPath, [COMPARE, ...args], { encoding: 'utf8' });

  // The headline case: the real pairing, withheld for the SUBSTANTIVE reason.
  {
    const v1 = writeV1('baseline');
    const r = run('--before', v1, '--after', modern);
    assert.equal(r.status, 3, 'the v1 side must load and then be withheld, not fail to load');
    const out = JSON.parse(r.stdout);

    // Proof the withhold is the gate and not a load failure: the v1 side is
    // present, its aggregates were recomputed, and they are real numbers.
    assert.equal(out.before.aggregates_source, RECOMPUTED);
    assert.equal(out.after.aggregates_source, PUBLISHED);
    assert.equal(out.before.capture_id, '2026-08-22T0815Z');
    assert.equal(out.delta, null);

    // And the reason is the discontinuity this project actually has.
    assert.ok(out.blocking_dimensions.includes('vantage.class'));
    assert.ok(out.blocking_dimensions.includes('instrument_policy.robots_unavailable'));
    assert.match(out.withheld_reason, /vantage\.class/);
    // Unrecorded on the v1 side, recorded on the automated side. Not "equal
    // because both are blank" — that rule is what stops the silent difference.
    assert.equal(out.dimensions['vantage.class'].before, 'unrecorded');
    assert.equal(out.dimensions['vantage.class'].after, 'github-hosted-dynamic-egress');
    assert.equal(out.dimensions['input.sha256'].equal, true, 'same domain list on both sides');

    // Acknowledging every blocking dimension releases a delta computed from the
    // recomputed side. Hand-counted from the fixture rows: 4 request rows, 2
    // sent, 2 reachable -> rate 1.0 over sent. Without this the test would prove
    // only that the tool can refuse, never that the recomputed numbers are right.
    const acked = run(
      '--before',
      v1,
      '--after',
      modern,
      ...out.blocking_dimensions.flatMap((d) => ['--acknowledge', d]),
    );
    assert.equal(acked.status, 0);
    const ok = JSON.parse(acked.stdout);
    assert.equal(ok.before.aggregates_source, RECOMPUTED);
    assert.equal(ok.delta.requests_sent.before, 2);
    assert.equal(ok.delta.outcomes.reachable.before, 2);
    assert.equal(ok.delta.outcomes.denied_by_robots.before, 2);
    assert.equal(ok.delta.reachable_rate_of_sent.before, 1);
    assert.equal(ok.delta.affordances.llms_txt.before, 1);
    assert.equal(ok.strictly_comparable, false, 'an acknowledged confounder is still a confounder');
  }

  // Recomputation is refused when the bytes are not the published bytes. The
  // hash is the only thing that makes recomputing an immutable release safe.
  {
    const tampered = writeV1('tampered', {}, Buffer.concat([bytes, Buffer.from('{"kind":"request"}\n')]));
    const r = run('--before', tampered, '--after', modern);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /do not match the published manifest/);
  }

  // ...and when the aggregator no longer reproduces the counts published beside
  // those bytes. The hash proves the bytes; this proves the reading of them.
  {
    const drifted = writeV1('drifted', { request_outcomes: { reachable: 99, denied_by_robots: 2 } });
    const r = run('--before', drifted, '--after', modern);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /disagree with the outcome counts published/);
    assert.match(r.stderr, /reachable: published 99, recomputed 2/);
  }

  // A hash that matches while the row count does not means the manifest and the
  // bytes disagree about what the capture IS, and an aggregate over the wrong
  // number of rows is a wrong number. Found uncovered by fault injection: this
  // guard existed in loadVerifiedCapture and no test in the repo exercised it,
  // so it was assurance nobody was holding.
  {
    const miscounted = writeV1('miscounted', {
      dataset: { name: 'miscounted.jsonl', sha256: createHash('sha256').update(bytes).digest('hex'), rows: 999 },
    });
    const r = run('--before', miscounted, '--after', modern);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /declares 999 rows; file holds 8/);
  }

  // Bytes absent entirely: an actionable error naming the flag for THIS side.
  {
    const orphan = join(dir, 'orphan.manifest.json');
    writeFileSync(
      orphan,
      JSON.stringify({ capture_id: 'x', dataset: { name: 'nowhere.jsonl', sha256: '0'.repeat(64), rows: 1 } }, null, 2),
    );
    const r = run('--before', orphan, '--after', modern);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--before-capture/);
    assert.doesNotMatch(r.stderr, /--after-capture/, 'the error must name the side that actually failed');
  }

  // A manifest may not steer the reader outside its own directory: only the
  // basename of dataset.name is used, so an absolute path in published data
  // cannot make the tool read some other file that happens to hash correctly.
  {
    const escaping = writeV1('escaping', { dataset: { name: '/etc/passwd', sha256: '0'.repeat(64), rows: 1 } });
    const r = run('--before', escaping, '--after', modern);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /passwd/);
    assert.doesNotMatch(r.stderr, /\/etc\/passwd/, 'dataset.name must be reduced to its basename');
  }
}

console.log('cross-capture gate: delta arithmetic, withholding, acknowledgement, v1 admission and exit codes passed');
