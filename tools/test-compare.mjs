#!/usr/bin/env node
//
// Tests for the cross-capture gate. The property under test is not "does it
// subtract correctly" — it is "does it REFUSE to subtract when the instrument
// moved". Both halves are checked, because a gate that never opens is as
// useless as one that never closes, and a green suite proves neither on its own.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareManifests, compareAggregates } from './compare.mjs';
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
  assert.match(missing.stderr, /no aggregates/);

  assert.equal(run('--before', same).status, 2, 'missing arguments must be a usage error');
}

console.log('cross-capture gate: delta arithmetic, withholding, acknowledgement and exit codes passed');
