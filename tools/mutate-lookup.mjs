// Vacuity guard for the traveler's answer engine and its MCP transport.
// Harness: tools/mutate.mjs
//
// This module's job is to WITHHOLD — to answer "we never asked" where a lazier
// tool would answer "blocked", and "unknown" where it would guess. A suite of
// withholding tests is the easiest kind to write vacuously, because a module
// that withheld everything would pass most of them. So every withholding rule
// below is broken on purpose in the direction a real implementation would drift:
// toward answering more, sooner, and more confidently.
//
// Four wakes running, this project has found its own tests weaker than they
// read. The recurring shape is a guard against something UNREALISTIC that only
// realistic fixtures were ever pointed at. The mutants that matter most here are
// the ones that make the module MORE useful and less honest — those are the
// changes a future author would actually make.
//
// Run: node tools/mutate-lookup.mjs

import { runMutants } from './mutate.mjs';

const LOOKUP = [
  // --- the not-attempted trap, which is most of the dataset -----------------
  [
    'a door we never knocked on is reported as the site refusing us',
    "  else if (known) evidence = 'robots-declaration';\n  else evidence = 'not-attempted';",
    "  else evidence = 'robots-declaration';",
  ],
  [
    'an outcome is served for a request that was never sent',
    'last_outcome: row.requested === true ? (row.outcome ?? null) : null,',
    'last_outcome: row.outcome ?? null,',
  ],
  [
    'an unreadable robots.txt is reported as the site saying no',
    "const declared = !known ? 'unreadable' : robots.allowed === false ? 'disallow' : 'allow';",
    "const declared = robots.allowed === false ? 'disallow' : 'allow';",
  ],
  [
    'the reason a policy was unreadable is dropped, so a redirect reads like a refusal',
    'reason: robots.reason ?? null,',
    'reason: null,',
  ],
  [
    'the coverage numbers count every door as behaviour',
    "row.requested === true ? 'behaviour' : row.robots?.known === true ? 'robots-declaration' : 'not-attempted';",
    "'behaviour';",
  ],
  [
    'the answer stops saying that not-attempted is about the instrument',
    "if (doors.some((d) => d.evidence === 'not-attempted')) {",
    'if (false) {',
  ],

  // --- age, which is the card's named failure mode --------------------------
  [
    'the freshness bound is invented here instead of imported',
    'ageMinutes <= PROBE_MATCH_MAX_LAG_MINUTES',
    'ageMinutes <= 1440',
  ],
  ["everything is fresh", "freshness: ageMinutes !== null && ageMinutes <= PROBE_MATCH_MAX_LAG_MINUTES ? 'fresh' : 'stale',", "freshness: 'fresh',"],
  [
    'age is measured from when the capture STARTED, understating it by the run duration',
    'const observedAt = m.observed_through ?? m.observed_from ?? null;',
    'const observedAt = m.observed_from ?? m.observed_through ?? null;',
  ],
  [
    'a stale answer no longer says it is stale',
    "if (as_of.freshness === 'stale') {",
    'if (false) {',
  ],
  [
    'the clock is invented rather than passed in',
    "if (!now) throw new Error('lookup() requires an explicit `now`');",
    'now = now ?? new Date().toISOString();',
  ],

  // --- the refusal to infer -------------------------------------------------
  [
    'an unprobed subdomain is answered from its parent',
    'const entry = index.byDomain.get(domain);',
    'const entry = index.byDomain.get(domain) ?? index.byDomain.get(domain.split(".").slice(1).join("."));',
  ],
  [
    'any string is accepted as a hostname',
    'if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {',
    'if (false) {',
  ],

  // --- the detour, where the same trap repeats one layer over ---------------
  [
    'a file we never fetched is reported as absent',
    "if (row.outcome === 'denied_by_robots') return 'unknown';",
    'void 0;',
  ],
  [
    'a soft 404 counts as a published affordance',
    "if (row.present === true) return row.soft_404 === true ? 'present-but-soft-404' : 'present';",
    "if (row.present === true) return 'present';",
  ],

  // --- crowd claims ---------------------------------------------------------
  [
    'quarantined and contested claims are served as fact',
    "      .filter((c) => c.state === 'corroborated')",
    "      .filter((c) => c.state !== 'expired')",
  ],
  [
    'contested claims stop being counted',
    "contested_claims: claims.filter((c) => c.state === 'contested').length,",
    'contested_claims: 0,',
  ],

  // --- the present-tense guard, which is itself a guard ---------------------
  [
    'the present-tense guard is a no-op',
    'if (PRESENT_TENSE_FIELD_NAMES.includes(key)) {',
    'if (false) {',
  ],
  [
    'the guard stops descending through arrays',
    'value.forEach((v, i) => assertNoPresentTenseField(v, `${path}[${i}]`));',
    'void 0;',
  ],
  [
    '`allowed` — the probe row\'s own field name — becomes permitted',
    "  'allowed',\n",
    '',
  ],

  // --- the fiddly ones ------------------------------------------------------
  // Added after the first pass caught everything on the first run, which is the
  // point at which this project has learned to distrust its own gate: a mutant
  // set that only names the obvious breaks reads as thorough while testing the
  // easy half. These are the edits that would survive a code review.
  [
    'the freshness comparison is off by one at the boundary itself',
    'ageMinutes <= PROBE_MATCH_MAX_LAG_MINUTES ?',
    'ageMinutes < PROBE_MATCH_MAX_LAG_MINUTES ?',
  ],
  [
    'a host counts as knocked-on because ANY of its rows was counted, not a behavioural one',
    "if (kind === 'behaviour') any = true;",
    'any = true;',
  ],
  [
    'the present-tense guard checks only top-level keys and never descends',
    'assertNoPresentTenseField(value[key], `${path}.${key}`);',
    'void 0;',
  ],
  [
    'an empty crowd block claims a resolution time it never had',
    'resolved_at: resolution?.resolved_at ?? null,',
    'resolved_at: resolution?.resolved_at ?? new Date().toISOString(),',
  ],

  // --- determinism ----------------------------------------------------------
  [
    'door order follows row arrival again',
    '.sort((a, b) => a.dialect.localeCompare(b.dialect));',
    ';',
  ],
];

const MCP = [
  [
    'a falsy request id is treated as a notification and never answered',
    'const isNotification = id === undefined || id === null;',
    'const isNotification = !id;',
  ],
  [
    'a stray log corrupts the protocol stream',
    "const write = (msg) => output.write(JSON.stringify(msg) + '\\n');",
    "const write = (msg) => { console.log('sending'); output.write(JSON.stringify(msg) + '\\n'); };",
  ],
  [
    'the server serves bytes it never verified against the published manifest',
    'const { rows } = loadVerifiedCapture(resolved, manifestPath);',
    "const rows = readFileSync(resolved, 'utf8').split('\\n').filter((l) => l.trim()).map((l) => JSON.parse(l));",
  ],
  [
    'refusing to serve exits 0, so a supervisor reads the refusal as a healthy start',
    'process.exit(3);',
    'process.exit(0);',
  ],
  [
    'a tool failure is reported as a success the calling model cannot see',
    'return toolResult({ error: String(err.message ?? err) }, true);',
    'return toolResult({ error: String(err.message ?? err) }, false);',
  ],
  [
    'an unknown method is silently swallowed',
    "return isNotification ? null : fail(id, METHOD_NOT_FOUND, `unknown method '${method}'`);",
    'return null;',
  ],
  [
    'unparseable input takes the whole server down mid-session',
    "      write(fail(null, PARSE_ERROR, 'could not parse JSON'));\n      return;",
    "      throw new Error('bad json');",
  ],
  [
    'tools/call with no name is answered instead of refused',
    "if (typeof name !== 'string') return fail(id, INVALID_PARAMS, 'tools/call requires params.name');",
    'void 0;',
  ],
];

const codes = [
  runMutants({ module: 'lookup.mjs', suite: 'test-lookup.mjs', mutants: LOOKUP }),
  runMutants({ module: 'mcp-server.mjs', suite: 'test-mcp.mjs', mutants: MCP }),
];
process.exit(Math.max(...codes));
