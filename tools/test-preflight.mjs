#!/usr/bin/env node

// The nightly's planning step, EXECUTED rather than read.
//
// Every capture so far — including the two that proved the path end to end —
// entered through `workflow_dispatch` with no `slot_date`, which is the `else`
// branch of this step. The `schedule` branch has never once run. Tonight it runs
// unsupervised, and it decides two things that cannot be repaired afterwards:
// whether a capture happens at all, and the `scheduled_slot` string that is the
// SOLE input to `observation_window` — the comparability dimension that shipped
// last wake. A slot string this step spells wrong does not fail; policy.mjs
// silently records `unrecorded`, and `unrecorded` never equals anything, so that
// night is permanently uncomparable to every night after it.
//
// test-workflow.mjs reads this file as text and asserts policy about it. Reading
// is not running: a regex can confirm `04:17:00` appears in the YAML and still
// tell you nothing about whether the string this step assembles round-trips
// through the parser that consumes it. So this test extracts the step's real
// `run:` body out of the workflow and runs it in a sandbox, with `gh` stubbed.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNRECORDED, observationWindow } from './policy.mjs';

const STEP_NAME = 'Plan one capture per local date';
const workflowPath = fileURLToPath(new URL('../.github/workflows/nightly-baseline.yml', import.meta.url));

/**
 * Pull the step's `run:` block out of the YAML by indentation.
 *
 * The hazard here is a silent one: an extractor that quietly matched nothing
 * would hand every case below an empty script, bash would exit 0, and a suite
 * that tested nothing at all would print green. So the extraction is asserted to
 * have found the real thing before a single case runs.
 */
function extractRunScript(yaml, stepName) {
  const lines = yaml.split('\n');
  const stepAt = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  assert.ok(stepAt >= 0, `step not found in workflow: ${stepName}`);

  const stepIndent = lines[stepAt].indexOf('- name:');
  let runAt = -1;
  for (let i = stepAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    // A new list item at or left of this step's indent means the step ended
    // without a `run:` — which must fail loudly rather than scan into the next.
    if (indent <= stepIndent) break;
    if (line.trim() === 'run: |') {
      runAt = i;
      break;
    }
  }
  assert.ok(runAt >= 0, `step has no "run: |" block: ${stepName}`);

  const bodyIndent = lines[runAt].length - lines[runAt].trimStart().length + 2;
  const body = [];
  for (let i = runAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') {
      body.push('');
      continue;
    }
    if (line.length - line.trimStart().length < bodyIndent) break;
    body.push(line.slice(bodyIndent));
  }
  // Trailing blank lines are an artifact of the block scalar, not the program.
  while (body.length && body[body.length - 1] === '') body.pop();
  return body.join('\n');
}

const script = extractRunScript(readFileSync(workflowPath, 'utf8'), STEP_NAME);

// Non-vacuity of the extraction itself. If the workflow is restructured so these
// anchors move, this test must go red and be rewritten against the new shape —
// not keep passing against a fragment.
assert.ok(script.length > 200, `extracted script is implausibly short (${script.length} bytes)`);
for (const anchor of [
  'set -euo pipefail',
  'gh release list',
  'should_run=',
  'capture_id=',
  'scheduled_slot=',
  '$GITHUB_OUTPUT',
]) {
  assert.ok(script.includes(anchor), `extracted script is missing anchor: ${anchor}`);
}

const root = mkdtempSync(join(tmpdir(), 'canireach-preflight-'));
const binDir = join(root, 'bin');
mkdirSync(binDir);

// The stub records every invocation. Without that record a case could assert the
// right answer while the script never consulted `gh` at all — or while a REAL gh
// on PATH answered instead, which would make the whole fixture decorative.
// (This is the shape that makes fake-binary tests vacuous when the script under
// test re-exports PATH or calls an absolute path; the record is how we know.)
const ghLog = join(root, 'gh.invocations');
writeFileSync(
  join(binDir, 'gh'),
  [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$*" >> "$GH_STUB_LOG"',
    'printf "%s" "$GH_STUB_RELEASES"',
  ].join('\n'),
  { mode: 0o755 },
);
chmodSync(join(binDir, 'gh'), 0o755);

let caseCount = 0;

/** Run the extracted step and return its outputs, or its failure. */
function plan({ event, slotDate = '', releases = [], runId = '77', attempt = '1', tz = null } = {}) {
  caseCount += 1;
  const outFile = join(root, `out.${caseCount}`);
  const logFile = join(root, `gh.${caseCount}`);
  writeFileSync(outFile, '');
  writeFileSync(logFile, '');
  const env = {
    PATH: `${binDir}:${process.env.PATH}`,
    HOME: root,
    EVENT_NAME: event,
    INPUT_SLOT_DATE: slotDate,
    RUN_ID: runId,
    RUN_ATTEMPT: attempt,
    GITHUB_REPOSITORY: 'BrunoOGclaw/canireach',
    GITHUB_OUTPUT: outFile,
    GH_TOKEN: 'stub-token-not-a-credential',
    GH_STUB_LOG: logFile,
    GH_STUB_RELEASES: JSON.stringify(releases),
  };
  if (tz) env.TZ = tz;

  let failure = null;
  try {
    execFileSync('bash', ['-c', script], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    failure = { status: err.status, stderr: String(err.stderr ?? '') };
  }
  const outputs = Object.fromEntries(
    readFileSync(outFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const eq = line.indexOf('=');
        return [line.slice(0, eq), line.slice(eq + 1)];
      }),
  );
  return { outputs, failure, ghCalls: readFileSync(logFile, 'utf8').split('\n').filter(Boolean) };
}

const chicagoToday = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());

// --- the branch that runs tonight -----------------------------------------

const scheduled = plan({ event: 'schedule' });
assert.equal(scheduled.failure, null, `schedule branch failed: ${scheduled.failure?.stderr}`);
assert.equal(scheduled.outputs.should_run, 'true');
assert.equal(scheduled.outputs.capture_id, `${chicagoToday}-slot0417-America_Chicago-schedule-gh77a1`);
assert.equal(scheduled.outputs.scheduled_slot, `${chicagoToday}T04:17:00[America/Chicago]`);
assert.equal(scheduled.ghCalls.length, 1, 'the schedule branch must consult the release list exactly once');
assert.match(scheduled.ghCalls[0], /^release list --repo BrunoOGclaw\/canireach /);

// THE CROSS-MODULE CONTRACT, and the reason this file exists. The workflow
// composes the slot string; policy.mjs parses it; nothing until now ran both.
// A spelling the parser rejects does not error — it degrades to `unrecorded`,
// silently and permanently, on the one dimension that had to ship before
// tonight.
const window = observationWindow(scheduled.outputs.scheduled_slot, '2026-08-23T09:19:00Z');
assert.equal(window.slot, '04:17[America/Chicago]', 'the workflow slot string must parse in policy.mjs');
assert.notEqual(window.slot, UNRECORDED);
assert.equal(window.nominal, `${chicagoToday}T04:17[America/Chicago]`);
assert.equal(typeof window.drift_minutes, 'number');

// The local date is the SLOT's zone, never the runner's. A GitHub runner is UTC,
// and 04:17 America/Chicago is 09:17Z — same date — so a zone bug would hide at
// the exact hour this job runs and surface only in one direction, on some nights,
// as a capture filed under the wrong date. Proven by running under a zone whose
// date differs from Chicago's right now; the span from Pacific/Kiritimati (+14)
// to Pacific/Midway (-11) guarantees such a zone exists at every hour.
const dateIn = (zone) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
const disagreeing = ['Pacific/Kiritimati', 'Asia/Tokyo', 'UTC', 'Pacific/Midway'].find(
  (z) => dateIn(z) !== chicagoToday,
);
assert.ok(disagreeing, 'no probe zone disagrees with Chicago today; the zone check would be vacuous');
const underForeignTz = plan({ event: 'schedule', tz: disagreeing });
assert.equal(underForeignTz.failure, null);
assert.ok(
  underForeignTz.outputs.capture_id.startsWith(`${chicagoToday}-slot0417-`),
  `local date followed TZ=${disagreeing} (${dateIn(disagreeing)}) instead of America/Chicago`,
);

// --- suppression: exactly one capture per local date, and no more ----------

const publishedTonight = [
  { tagName: `baseline-${chicagoToday}-slot0417-America_Chicago-schedule-gh1a1`, isDraft: false, isImmutable: true },
];
assert.equal(
  plan({ event: 'schedule', releases: publishedTonight }).outputs.should_run,
  'false',
  'a published immutable release for this local date must suppress the fallback slot',
);

// A half-published release is not a capture. If a draft or a still-mutable
// release suppressed the 05:17 fallback, a publish job that died between
// creating the draft and sealing it would cost the night — and the fallback
// exists precisely for the runs that do not complete.
// The third fixture is a state GitHub should never report — a draft cannot be
// immutable, and the publish job asserts exactly that before it seals anything.
// It is here because the `!isDraft` clause exists for the case where the API
// says otherwise, and without it that clause is covered by nothing: a fixture
// that is BOTH draft and mutable is rejected by the `isImmutable` half, so
// deleting `!isDraft` changes no outcome and the guard reads as tested while
// being unheld. Realistic fixtures alone cannot cover a defence against the
// unrealistic.
for (const [label, release] of [
  ['draft', { ...publishedTonight[0], isDraft: true, isImmutable: false }],
  ['mutable', { ...publishedTonight[0], isDraft: false, isImmutable: false }],
  ['draft-reported-immutable', { ...publishedTonight[0], isDraft: true, isImmutable: true }],
]) {
  assert.equal(
    plan({ event: 'schedule', releases: [release] }).outputs.should_run,
    'true',
    `a ${label} release must not suppress the fallback slot`,
  );
}

assert.equal(
  plan({
    event: 'schedule',
    releases: [{ tagName: 'baseline-2000-01-01-slot0417-America_Chicago-schedule-gh1a1', isDraft: false, isImmutable: true }],
  }).outputs.should_run,
  'true',
  'another date\'s release must not suppress today',
);

// --- the manual branch must stay unable to satisfy a real slot -------------

const manual = plan({ event: 'workflow_dispatch' });
assert.equal(manual.failure, null, `manual branch failed: ${manual.failure?.stderr}`);
assert.equal(manual.outputs.should_run, 'true');
assert.equal(manual.outputs.scheduled_slot, 'manual');
assert.equal(
  observationWindow(manual.outputs.scheduled_slot, '2026-08-22T16:23:00Z').slot,
  UNRECORDED,
  'a hand-run capture must not claim a repeatable slot',
);
assert.match(manual.outputs.capture_id, /^\d{4}-\d{2}-\d{2}T\d{6}Z-manual-gh77a1$/);
// The load-bearing property checked before the last two manual dispatches were
// fired: a manual capture_id can never carry the prefix the suppression
// predicate looks for, so verifying the path can never consume the night.
assert.ok(
  !manual.outputs.capture_id.startsWith(`${chicagoToday}-slot0417-`),
  'a manual capture must not be able to satisfy and suppress the real slot',
);
assert.deepEqual(manual.ghCalls, [], 'the manual branch must not query releases at all');

// --- forced verification of a named slot ----------------------------------

const forced = plan({ event: 'workflow_dispatch', slotDate: '2026-12-31' });
assert.equal(forced.failure, null);
assert.equal(forced.outputs.capture_id, '2026-12-31-slot0417-America_Chicago-workflow-dispatch-gh77a1');
assert.equal(forced.outputs.scheduled_slot, '2026-12-31T04:17:00[America/Chicago]');
assert.equal(forced.ghCalls.length, 1, 'a forced slot must still honour the one-per-date rule');

const malformed = plan({ event: 'workflow_dispatch', slotDate: '31-12-2026' });
assert.ok(malformed.failure, 'a malformed slot_date must fail rather than invent a date');
assert.equal(malformed.failure.status, 2);
assert.deepEqual(malformed.outputs, {}, 'a rejected plan must emit no outputs');

rmSync(root, { recursive: true, force: true });
console.log(`nightly preflight: ${caseCount} executions of the real planning step passed (schedule branch, slot round-trip, suppression, manual isolation)`);
