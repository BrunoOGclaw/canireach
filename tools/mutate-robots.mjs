// Vacuity guard for the robots.txt parser tests. Harness: tools/mutate.mjs
//
// Run: node tools/mutate-robots.mjs

import { runMutants } from './mutate.mjs';

const MUTANTS = [
  // Context-qualified: `want.startsWith(a)` alone appears in both selectGroup and
  // hasExplicitGroup, and a two-site mutation tests neither rule cleanly.
  ['prefix agent matching disabled', 'if (want === a || want.startsWith(a)) {', 'if (want === a) {'],
  ['shortest matching group wins instead of longest', 'groupBestLen > bestLen', 'groupBestLen < bestLen'],
  ['wildcard group beats a named group', 'best || wildcard || null', 'wildcard || best || null'],
  ['Disallow wins an equal-length tie', "rule.type === 'allow'", 'false'],
  ['shorter path rule wins', 'rule.path.length > winner.path.length', 'rule.path.length < winner.path.length'],
  ['empty Disallow blocks everything', "if (pattern === '') return false;", "if (pattern === '') return true;"],
  ['* stops being a wildcard', "if (c === '*') re += '.*';", "if (c === '*') re += '\\\\*';"],
  ['$ stops anchoring the end', "c === '$' && i === pattern.length - 1", 'false'],
  ['later wildcard group replaces earlier rules', 'wildcard.rules.push(...g.rules);', 'wildcard.rules = [...g.rules];'],
  ['later equally specific named group is ignored', 'best.rules.push(...g.rules);', 'void g.rules;'],
];

process.exit(runMutants({ module: 'robots.mjs', suite: 'test-robots.mjs', mutants: MUTANTS }));
