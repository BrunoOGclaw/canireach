// Vacuity guard for the capture validator. Harness: tools/mutate.mjs
//
// The validator is the gate that decides whether a night's capture is
// publishable at all, and #19 added guards to it: the robots redirect chain and
// an exact row-schema check. Reviewing a guard is not the same as testing it,
// and this project has already found one guard that the entire suite could be
// green without. Only injection tells the two apart.
//
// Run: node tools/mutate-artifact.mjs

import { runMutants } from './mutate.mjs';

const MUTANTS = [
  // --- the row schema is a comparability dimension, so it must be exact -----
  ['any row schema is publishable', 'if (row.schema_version !== ROW_SCHEMA_VERSION)', 'if (false)'],
  ['the schema check accepts one version behind', 'row.schema_version !== ROW_SCHEMA_VERSION', 'row.schema_version < ROW_SCHEMA_VERSION - 1'],

  // --- the redirect chain is the audit trail for a followed policy ----------
  ['the chain is never validated at all', 'if (row.redirect_chain !== undefined)', 'if (row.redirect_chain === undefined)'],
  ['the published hop count may disagree with the chain', 'if (row.redirect_hops !== row.redirect_chain.length)', 'if (false)'],
  ['a chain may exceed the follow budget', 'if (row.redirect_chain.length > 6)', 'if (row.redirect_chain.length > 60)'],
  ['a non-redirect status may sit in the chain', 'if (!Number.isInteger(hop.status) || hop.status < 300 || hop.status > 399)', 'if (false)'],
  ['a hop may carry unapproved keys', "assertKeys(hop, REDIRECT_HOP_KEYS, 'redirect hop', index + 1);", 'void hop;'],
];

process.exit(runMutants({ module: 'finalize-run.mjs', suite: 'test-run-artifact.mjs', mutants: MUTANTS }));
