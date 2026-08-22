// Pulling a workflow step's real `run:` body out of the YAML, so a test can
// execute the code that will actually run rather than a retyped copy of it.
//
// Shared because two tests need it and a second implementation would be a second
// chance for the extraction to silently match nothing — which is the failure
// mode that matters here. An extractor that quietly returns an empty string
// hands every case an empty script, bash exits 0, and a suite that tested
// nothing prints green. Callers assert on the result before using it.

import assert from 'node:assert/strict';

export function extractRunScript(yaml, stepName) {
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
    // without a `run:` — fail loudly rather than scan on into the next step.
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
  while (body.length && body[body.length - 1] === '') body.pop();
  return body.join('\n');
}

/** Assert an extraction found the real program before any case runs against it. */
export function assertExtracted(script, anchors, label) {
  assert.ok(script.length > 100, `extracted ${label} is implausibly short (${script.length} bytes)`);
  for (const anchor of anchors) {
    assert.ok(script.includes(anchor), `extracted ${label} is missing anchor: ${anchor}`);
  }
}
