// Vacuity guard for the public surface. Harness: tools/mutate.mjs
//
// The site now publishes a CALLABLE interface, not just measurements. Prose
// about a measurement can be a little stale and still be honest; a tool
// signature cannot — an agent that reads /api/mcp.json and wires up what it
// finds there has no second source. So the checks that keep the descriptor
// welded to the running server are the ones most worth proving are real, and
// this repository has already found guards the entire suite could be green
// without.
//
// Run: node tools/mutate-site.mjs

import { runMutants } from './mutate.mjs';

const MUTANTS = [
  // --- the tool copy mapping, in both directions ----------------------------
  ['a served tool may have no page copy', 'const missing = served.filter((name) => !words[name]);', 'const missing = [];'],
  [
    'page copy may survive the tool it describes',
    'const orphaned = Object.keys(words).filter((name) => !served.includes(name));',
    'const orphaned = [];',
  ],

  // --- the descriptor is the server's own tool list, or it is fiction -------
  [
    'the descriptor publishes a hand-written tool list',
    '    tools: TOOLS,',
    "    tools: [{ name: 'reachability_lookup', description: 'Look up a domain.', inputSchema: { type: 'object' } }],",
  ],
  [
    'the descriptor drops the input schemas',
    '    tools: TOOLS,',
    '    tools: TOOLS.map(({ name, description }) => ({ name, description })),',
  ],
  [
    'the descriptor renames the tools it advertises',
    '    tools: TOOLS,',
    '    tools: TOOLS.map((t) => ({ ...t, name: `cir_${t.name}` })),',
  ],
  ['the descriptor states a protocol version of its own', "      protocol_version: PROTOCOL_VERSION,", "      protocol_version: '2024-11-05',"],
  ['the descriptor states a server version of its own', '      version: SERVER_VERSION,', "      version: '9.9.9',"],
  [
    'the descriptor publishes an invocation the server would reject',
    "      args: ['tools/mcp-server.mjs', '--manifest', '<capture>.final.manifest.json'],",
    "      args: ['tools/mcp-server.mjs', '--capture', '<capture>.jsonl'],",
  ],

  // --- the coverage split is the dataset's most important disclosure --------
  [
    'the behavioural-coverage count is typed rather than measured',
    '    domains_with_any_behavioural_evidence: status.domains_with_any_behavioural_evidence,',
    '    domains_with_any_behavioural_evidence: 195,',
  ],
  [
    'the evidence split is carried forward instead of recomputed',
    '    doors_by_evidence: status.doors_by_evidence,',
    "    doors_by_evidence: { behaviour: 195, 'robots-declaration': 100, 'not-attempted': 3955 },",
  ],

  // Every figure in the flattening sentence is derived, which is precisely why
  // the SUM is where it can quietly go wrong. A derived number is not a correct
  // number, and adding the wrong pair reads identically in the source.
  [
    'the flattening claim adds the wrong pair of numbers',
    "<strong>${doors['robots-declaration'] + doors['not-attempted']}</strong> doors as refused",
    "<strong>${doors['robots-declaration']}</strong> doors as refused",
  ],
  [
    'the flattening claim counts behavioural doors as refusals',
    "${doors['robots-declaration'] + doors['not-attempted']}</strong> doors as refused",
    "${doors.behaviour + doors['not-attempted']}</strong> doors as refused",
  ],
  [
    'the override refusal never fires',
    "    const clobbered = Object.keys(words[t.name]).filter((k) => k in t);",
    '    const clobbered = [];',
  ],
  // Page copy is allowed to frame a tool. It is not allowed to REPLACE the
  // server's own description of it, which is the text a model will act on.
  [
    'page copy overrides the description the server publishes',
    '  return tools.map((t) => ({ ...t, ...words[t.name] }));',
    '  return tools.map((t) => ({ ...t, ...words[t.name], description: words[t.name].when }));',
  ],

  // --- nothing static may assert its own recency ---------------------------
  //
  // The realistic way this breaks is not someone typing `age_minutes`. It is
  // someone spreading datasetStatus()'s whole return value into the block —
  // which is one keystroke, reads as tidier, and drags `as_of.age_minutes` and
  // `as_of.freshness` into a file a CDN will cache for hours. That mutant
  // exercises the guard AND the fact that buildSite actually calls it.
  [
    'the coverage block spreads the clock-dependent status wholesale',
    '  const coverage = {\n    domains_indexed: status.domains_indexed,',
    '  const coverage = {\n    ...status,\n    domains_indexed: status.domains_indexed,',
  ],
  ['the volatile-key guard never fires', 'if (VOLATILE_ARTIFACT_KEYS.includes(key)) {', 'if (false) {'],
  [
    'the volatile-key guard does not look inside arrays',
    'value.forEach((v, i) => assertNoVolatileClaim(v, `${path}[${i}]`));\n    return value;',
    'return value;',
  ],
  [
    'the volatile-key guard does not recurse into nested objects',
    'assertNoVolatileClaim(value[key], `${path}.${key}`);',
    'void key;',
  ],

  // --- the refusals the page and descriptor both advertise ------------------
  [
    'the descriptor hand-lists the fields an answer may never contain',
    '    forbidden_answer_fields: PRESENT_TENSE_FIELD_NAMES,',
    "    forbidden_answer_fields: ['reachable', 'blocked'],",
  ],
  [
    'the page stops listing the refused field names',
    '<p>${PRESENT_TENSE_FIELD_NAMES.map((n) => `<code>${esc(n)}</code>`).join(\', \')}</p>',
    '<p></p>',
  ],

  // --- discoverability: a page in one index and not the other --------------
  [
    'the mcp page is advertised but never built',
    "  files.set(\n    'mcp.html',",
    "  if (false) files.set(\n    'mcp.html',",
  ],
  [
    'the mcp page is built but left out of the sitemap',
    "  { path: 'mcp.html', url: '/mcp', title: 'The MCP tool — Can I Reach?' },\n",
    '',
  ],
];

process.exit(runMutants({ module: 'build-site.mjs', suite: 'test-site.mjs', mutants: MUTANTS }));
