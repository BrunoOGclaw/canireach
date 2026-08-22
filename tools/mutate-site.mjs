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
  // --- #27: the published command has to be one that actually runs ----------
  // The defect these exist for shipped green through a check whose own title
  // was "the invocation the site publishes is the one the server accepts": it
  // asserted --manifest was present and never looked at the filename beside it.
  [
    'the descriptor publishes an invocation the server would reject',
    "      args: ['tools/mcp-server.mjs', MANIFEST_FLAG, served],",
    "      args: ['tools/mcp-server.mjs', '--capture', served],",
  ],
  [
    'the manifest name goes back to the literal that shipped',
    '  const served = basename(String(manifestPath));',
    "  const served = '<capture>.final.manifest.json';",
  ],
  [
    'the manifest name is a plausible literal rather than the capture rendered',
    '  const served = basename(String(manifestPath));',
    "  const served = 'baseline.manifest.json';",
  ],
  [
    'the placeholder refusal never fires',
    '  const placeholder = args.find((a) => /[<>]/.test(String(a)));',
    '  const placeholder = undefined;',
  ],
  [
    'the build stops checking that the argv names the capture it rendered',
    '  if (named !== expectedManifest) {',
    '  if (false) {',
  ],
  [
    'the manifest argument is found by position instead of by its flag',
    '  const at = invocation.args.indexOf(MANIFEST_FLAG);\n  return at < 0 ? null : invocation.args[at + 1];',
    '  return invocation.args[invocation.args.length - 1];',
  ],
  [
    'the refusal is exported but not wired into the derivation',
    '  return assertRunnableInvocation(\n    {',
    '  return ((invocation) => invocation)(\n    {',
  ],
  [
    'the naming convention is restated instead of read from the writer',
    "  const naming = basename(sidecars('probes/capture.jsonl', '<capture-id>').manifest);",
    "  const naming = '<capture-id>.final.manifest.json';",
  ],
  [
    'the run-it block stops printing the derived argv',
    '${esc(invocation.command)} ${invocation.args.map((a) => esc(a)).join(\' \')}',
    'node tools/mcp-server.mjs --manifest &lt;capture&gt;.final.manifest.json',
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

  // --- #24: the capture this surface renders is named, and it is pinned -----
  // The defect these exist for shipped green: every number was recomputed from
  // hashed bytes and correct, and the word beside them was "current" on a page
  // pinned to the oldest capture in the project.
  [
    'a page may call its pinned capture the current one',
    '  for (const [rel, body] of files) assertNoCurrencyClaim(body, rel);',
    '',
  ],
  [
    'the currency guard matches nothing',
    '  const found = CURRENCY_CLAIMS.filter((phrase) => lower.includes(phrase));',
    '  const found = [];',
  ],
  [
    'the currency guard is case-sensitive, so a capitalised claim walks through',
    '  const lower = String(text).toLowerCase();',
    '  const lower = String(text);',
  ],
  [
    'the coverage sentence stops naming its capture',
    '<p>Of ${c.domains_indexed} domains in capture <code>${esc(s.capture_id)}</code> (<code>${esc(s.capture_class)}</code>), <strong>',
    '<p>Of ${c.domains_indexed} domains, <strong>',
  ],
  [
    'the descriptor stops saying which capture it describes',
    '      capture_class: s.capture_class,',
    '',
  ],
  [
    'the descriptor stops disclosing that this surface is pinned',
    '      selection: CAPTURE_SELECTION,',
    '',
  ],

  // --- the instrument sentence is READ, never written -----------------------
  [
    'the instrument sentence goes back to a literal about one capture',
    '      vantage_note: vantageNote(profile),',
    "      vantage_note: 'This capture was taken from a residential vantage with robots-unavailable failing open.',",
  ],
  [
    'a table cell asserts a robots policy this capture did not run',
    'We could not read <code>robots.txt</code> as policy and sent no request. A fact about us.',
    'We could not read <code>robots.txt</code> and failed closed. A fact about us.',
  ],
  [
    'the page names the instrument policy as a literal instead of importing it',
    '<code>${esc(INSTRUMENT_POLICY.robots_unavailable)}</code>',
    '<code>fail-closed-only</code>',
  ],

  // The profile and observed-policy derivations live in lookup.mjs, so their
  // mutants live in mutate-lookup.mjs. Six of them sat here first and reported
  // INVALID rather than caught, which is the harness refusing to let a registry
  // claim coverage of a file it does not patch.
  [
    'the instrument sentence drops the vantage it claims to report',
    "    `This capture declares vantage class \\`${v('vantage.class')}\\`, robots-unavailable policy ` +",
    '    `This capture declares a vantage class, robots-unavailable policy ` +',
  ],
];

process.exit(runMutants({ module: 'build-site.mjs', suite: 'test-site.mjs', mutants: MUTANTS }));
