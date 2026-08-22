#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const workflowUrl = new URL('../.github/workflows/nightly-baseline.yml', import.meta.url);
const workflow = readFileSync(fileURLToPath(workflowUrl), 'utf8');
const ciUrl = new URL('../.github/workflows/test.yml', import.meta.url);
const ci = readFileSync(fileURLToPath(ciUrl), 'utf8');

// Both gates must run EVERY test by discovery. The failure this prevents is
// specific and had already happened: test-aggregate.mjs existed, ran in CI, and
// was absent from the nightly's pre-flight gate, so the unattended run that
// actually touches the network was proving less than the pull request did.
const suite = readdirSync(fileURLToPath(new URL('.', import.meta.url)))
  .filter((f) => /^test-.*\.mjs$/.test(f))
  .sort();
assert.ok(suite.length >= 6, `test discovery found only ${suite.length} files`);
for (const [label, text] of [['nightly', workflow], ['ci', ci]]) {
  assert.match(text, /for t in tools\/test-\*\.mjs; do/, `${label} must discover the suite, not list it`);
  assert.match(text, /node tools\/mutate-robots\.mjs/, `${label} must run the robots mutation gate`);
  // A discovery loop that ran nothing would pass a `for` loop silently.
  assert.match(text, /node "\$t"/, `${label} must execute each discovered test`);
}

assert.match(workflow, /cron: '17 4,5 \* \* \*'/);
assert.match(workflow, /timezone: 'America\/Chicago'/);
assert.match(workflow, /group: canireach-nightly-baseline\n  cancel-in-progress: false/);
assert.doesNotMatch(workflow, /immutable-releases/);
assert.doesNotMatch(workflow, /--clobber/);
assert.match(workflow, /--json tagName,isDraft,isImmutable/);
assert.match(workflow, /!x\.isDraft&&x\.isImmutable/);

const capture = workflow.slice(workflow.indexOf('  capture:'), workflow.indexOf('  publish:'));
const publish = workflow.slice(workflow.indexOf('  publish:'), workflow.indexOf('  series:'));
const series = workflow.slice(workflow.indexOf('  series:'), workflow.indexOf('  failure-alert:'));
assert.ok(publish.length > 100 && series.length > 100, 'job slicing found nothing; the boundaries moved');
assert.match(capture, /permissions:\n      contents: read/);
assert.match(capture, /persist-credentials: false/);
assert.doesNotMatch(capture, /github\.token|GH_TOKEN|gh release/);
assert.match(publish, /permissions:\n      contents: write/);
assert.doesNotMatch(publish, /probe\.mjs/);

const draft = publish.indexOf('gh release create');
const draftFlag = publish.indexOf('--draft', draft);
const publishDraft = publish.indexOf('gh release edit', draftFlag);
const immutableCheck = publish.indexOf("test \"$immutable\" = true", publishDraft);
const preserveImmutable = publish.indexOf('cleanup_release=false', immutableCheck);
const verifyRelease = publish.indexOf('gh release verify', preserveImmutable);
assert.ok(draft >= 0 && draftFlag > draft, 'release must start as a draft');
assert.ok(publishDraft > draftFlag, 'draft must be published only after asset attachment');
assert.ok(immutableCheck > publishDraft, 'published release must be proven immutable');
assert.ok(preserveImmutable > immutableCheck, 'mutable publication failures must remain cleanup-eligible');
assert.ok(verifyRelease > preserveImmutable, 'attestation must follow immutable-state proof');
assert.match(publish, /gh release delete "\$tag" .* --cleanup-tag --yes/);

// The series comparison is derived work standing downstream of an unrecoverable
// one. Two properties keep it from ever costing a night:
//   - nothing depends on it, so it cannot block or fail the capture; and
//   - it never holds `contents: write`, so it cannot touch a release.
assert.match(series, /needs: \[preflight, capture, publish\]/);
assert.match(series, /permissions:\n      contents: read\n      issues: write/);
// Anchored to the key, not the word: the job's own comment says `contents: write`
// to explain why it must not have it.
assert.doesNotMatch(series, /^\s+contents: write/m);
assert.doesNotMatch(series, /probe\.mjs/);
for (const [job, block] of [['capture', capture], ['publish', publish], ['failure-alert', workflow.slice(workflow.indexOf('  failure-alert:'))]]) {
  assert.doesNotMatch(block, /needs:.*series/, `${job} must not depend on the series comparison`);
}
// Withheld and no-partner are findings; only a comparison that never reached the
// gate is a broken job. Collapsing them would make the gate holding look like a
// failure, and a failure look like the gate holding.
assert.match(series, /if \[ "\$select_code" = 4 \]/, 'no-partner must be handled distinctly');
assert.match(series, /\[ "\$compare_code" = 0 \] \|\| \[ "\$compare_code" = 3 \] \|\| exit "\$compare_code"/);

for (const use of workflow.matchAll(/uses:\s*([^\s#]+)/g)) {
  assert.match(use[1], /^[^@]+@[0-9a-f]{40}$/, `action is not pinned to a full SHA: ${use[1]}`);
}

console.log('nightly workflow policy: schedule, separation, pinning, and fail-closed publication passed');
