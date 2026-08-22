// Vacuity guard for the robots.txt parser tests.
//
// A green test suite proves nothing until you have watched it go red. This runs
// test-robots.mjs against deliberately broken copies of robots.mjs. Every mutant
// must be caught by at least one case.
//
// Three guards, each learned the hard way:
//  1. The base suite must be GREEN first. With a red base every mutant "passes"
//     because the already-failing test fails again.
//  2. Each mutation must actually CHANGE the source (a typo'd search string that
//     matches nothing would otherwise read as a caught mutant).
//  3. Each mutation must match EXACTLY ONCE, so a mutant tests the rule it names
//     rather than shotgunning the file.
//
// Run: node tools/mutate-robots.mjs

import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HERE = new URL('.', import.meta.url).pathname;

const MUTANTS = [
  // Context-qualified: `want.startsWith(a)` alone appears in both selectGroup and
  // hasExplicitGroup, and a two-site mutation tests neither rule cleanly.
  ['prefix agent matching disabled', 'if (want === a || want.startsWith(a)) {', 'if (want === a) {'],
  ['shortest agent token wins instead of longest', 'a.length > bestLen', 'a.length < bestLen'],
  ['wildcard group beats a named group', 'best || wildcard || null', 'wildcard || best || null'],
  ['Disallow wins an equal-length tie', "rule.type === 'allow'", 'false'],
  ['shorter path rule wins', 'rule.path.length > winner.path.length', 'rule.path.length < winner.path.length'],
  ['empty Disallow blocks everything', "if (pattern === '') return false;", "if (pattern === '') return true;"],
  ['* stops being a wildcard', "if (c === '*') re += '.*';", "if (c === '*') re += '\\\\*';"],
  ['$ stops anchoring the end', "c === '$' && i === pattern.length - 1", 'false'],
  ['later wildcard group replaces earlier rules', 'wildcard.rules.push(...g.rules);', 'wildcard.rules = [...g.rules];'],
];

function runSuite(dir) {
  try {
    execFileSync(process.execPath, [join(dir, 'test-robots.mjs')], {
      env: { ...process.env, CIR_MUTANT: '1' },
      stdio: 'pipe',
    });
    return true; // green
  } catch {
    return false; // red
  }
}

// Guard 1: base must be green.
const base = mkdtempSync(join(tmpdir(), 'cir-base-'));
cpSync(HERE, base, { recursive: true });
if (!runSuite(base)) {
  console.error('REFUSING TO MUTATE: the base suite is already red. Fix it first —');
  console.error('with a red base every mutant reads as "caught" and this whole pass is a no-op.');
  rmSync(base, { recursive: true, force: true });
  process.exit(2);
}
rmSync(base, { recursive: true, force: true });

const source = readFileSync(join(HERE, 'robots.mjs'), 'utf8');
let escaped = 0;
let invalid = 0;

for (const [label, find, replace] of MUTANTS) {
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
  writeFileSync(join(dir, 'robots.mjs'), mutated);
  const green = runSuite(dir);
  rmSync(dir, { recursive: true, force: true });

  if (green) {
    console.log(`  ESCAPED  ${label} — no test noticed this break`);
    escaped++;
  } else {
    console.log(`  caught   ${label}`);
  }
}

const bad = escaped + invalid;
console.log(`\n${MUTANTS.length - bad}/${MUTANTS.length} mutants caught (${escaped} escaped, ${invalid} invalid)`);
process.exit(bad ? 1 : 0);
