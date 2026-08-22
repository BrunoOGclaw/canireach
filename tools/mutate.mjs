// Shared vacuity-guard harness.
//
// A green test suite proves nothing until you have watched it go red. This runs
// a suite against deliberately broken copies of the module it tests. Every
// mutant must be caught by at least one case.
//
// Three guards, each learned the hard way:
//  1. The base suite must be GREEN first. With a red base every mutant "passes"
//     because the already-failing test fails again.
//  2. Each mutation must actually CHANGE the source (a typo'd search string that
//     matches nothing would otherwise read as a caught mutant).
//  3. Each mutation must match EXACTLY ONCE, so a mutant tests the rule it names
//     rather than shotgunning the file.
//
// This file is the harness only. Each `tools/mutate-*.mjs` is a registry that
// calls it, and CI DISCOVERS those rather than listing them — the list it used
// to keep had already drifted once, in exactly the way this project keeps
// finding: a list covers what its author thought of.

import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HERE = new URL('.', import.meta.url).pathname;

function runSuite(dir, suite) {
  try {
    execFileSync(process.execPath, [join(dir, suite)], {
      env: { ...process.env, CIR_MUTANT: '1' },
      stdio: 'pipe',
    });
    return true; // green
  } catch {
    return false; // red
  }
}

/**
 * @param {object} spec
 * @param {string} spec.module  file under tools/ to mutate, e.g. 'robots.mjs'
 * @param {string} spec.suite   file under tools/ to run, e.g. 'test-robots.mjs'
 * @param {Array<[string,string,string]>} spec.mutants  [label, find, replace]
 * @returns {number} process exit code
 */
export function runMutants({ module: moduleFile, suite, mutants }) {
  // Guard 1: base must be green.
  const base = mkdtempSync(join(tmpdir(), 'cir-base-'));
  cpSync(HERE, base, { recursive: true });
  const baseGreen = runSuite(base, suite);
  rmSync(base, { recursive: true, force: true });
  if (!baseGreen) {
    console.error(`REFUSING TO MUTATE ${moduleFile}: ${suite} is already red. Fix it first —`);
    console.error('with a red base every mutant reads as "caught" and this whole pass is a no-op.');
    return 2;
  }

  const source = readFileSync(join(HERE, moduleFile), 'utf8');
  let escaped = 0;
  let invalid = 0;

  for (const [label, find, replace] of mutants) {
    const parts = source.split(find);
    // Guards 2 and 3: the mutation must apply, exactly once.
    if (parts.length !== 2) {
      console.log(`  INVALID  ${label} — search string matched ${parts.length - 1} times, expected 1`);
      invalid++;
      continue;
    }
    const mutated = parts.join(replace);
    if (mutated === source) {
      console.log(`  INVALID  ${label} — mutation did not change the source`);
      invalid++;
      continue;
    }

    const dir = mkdtempSync(join(tmpdir(), 'cir-mut-'));
    cpSync(HERE, dir, { recursive: true });
    writeFileSync(join(dir, moduleFile), mutated);
    const green = runSuite(dir, suite);
    rmSync(dir, { recursive: true, force: true });

    if (green) {
      console.log(`  ESCAPED  ${label} — no test noticed this break`);
      escaped++;
    } else {
      console.log(`  caught   ${label}`);
    }
  }

  const bad = escaped + invalid;
  console.log(`\n${moduleFile}: ${mutants.length - bad}/${mutants.length} mutants caught (${escaped} escaped, ${invalid} invalid)`);
  return bad ? 1 : 0;
}
