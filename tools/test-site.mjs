// Gates on the public surface.
//
// The site's only real claim is that its numbers came from the bytes it names.
// These tests check that claim mechanically, against the BUILT OUTPUT rather
// than the source that produced it — verifying the generator instead of the
// generated file is how a broken transform passes its own test.
//
// EVERY CHECK RUNS AGAINST A FIXTURE THIS FILE BUILDS. The published captures
// live in GitHub releases and are gitignored, so a suite that needed one would
// simply not run in a fresh checkout — and a gate that cannot run in CI is a
// gate that is not enforcing anything. When a real capture IS present locally
// the identical suite runs against it too, so the fixture is a floor, never a
// substitute.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregate } from './aggregate.mjs';
import { SITE_FILES } from './dialects.mjs';
import { DIALECTS, PROBE_CONTACT } from './dialects.mjs';
import {
  DIMENSION_WORDS,
  SITE_ORIGIN,
  TOOL_WORDS,
  VOLATILE_ARTIFACT_KEYS,
  assertNoVolatileClaim,
  buildSite,
  comparabilityPhrase,
  loadVerifiedCapture,
  toolSpecs,
} from './build-site.mjs';
import { COMPARABILITY_DIMENSIONS } from './policy.mjs';
import { PRESENT_TENSE_FIELD_NAMES, buildIndex, datasetStatus } from './lookup.mjs';
import { DIALECT_TO_CLASS } from './reports.mjs';
import { SERVER_NAME, TOOLS } from './mcp-server.mjs';

const REAL_CAPTURE = 'data/probes/2026-08-22T0815Z.jsonl';
const REAL_MANIFEST = 'data/probes/2026-08-22T0815Z.final.manifest.json';

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}\n     ${err.message}`);
  }
};
const eq = (a, b, msg) => {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const throws = (fn, re, msg) => {
  let threw = null;
  try {
    fn();
  } catch (err) {
    threw = err;
  }
  if (!threw) throw new Error(`${msg}: expected a throw, got none`);
  if (!re.test(threw.message)) throw new Error(`${msg}: threw ${JSON.stringify(threw.message)}, expected /${re.source}/`);
};

/**
 * A synthetic capture with the shape of a real one.
 *
 * `vendorDenials` is a parameter so the suite can build a capture in which the
 * page's central claim is FALSE and confirm the gate rejects it. A check that
 * has only ever seen data agreeing with it has not been shown to discriminate.
 *
 * `unreadableEvery` exists because of a mutant that escaped this suite. Both
 * datasets it ran against — this fixture and the published v1 baseline — were
 * taken with robots-unavailable failing OPEN, so both contain ZERO
 * `not-attempted` doors, and every check involving that count was arithmetic on
 * a zero. The automated nightly series fails CLOSED, where that class is the
 * majority of the dataset and is the whole subject of #17. A fixture that omits
 * the evidence class the page exists to explain cannot test the page.
 */
function makeFixture(dir, { domains = 40, vendorDenials = 30, browserDenials = 4, unreadableEvery = 9 } = {}) {
  const rows = [];
  // robots.txt came back unreadable: our policy fails closed, so no request is
  // sent to ANY caller — a fact about this instrument, carrying no information
  // about the host.
  const robotsUnreadable = (i) => unreadableEvery > 0 && i % unreadableEvery === unreadableEvery - 1;
  const denyFor = (dialect, i) => {
    const kind = DIALECTS.find((d) => d.id === dialect).kind;
    if (kind === 'vendor-token-disclosed') return i < vendorDenials;
    if (dialect === 'browser' || dialect === 'curl' || dialect === 'canireach') return i < browserDenials;
    return false;
  };
  for (let i = 0; i < domains; i++) {
    const domain = `example${i}.test`;
    const base = { ts: '2026-08-22T00:00:00.000Z', run: 'fixture', rank: i + 1, domain, schema_version: 1 };
    for (const f of SITE_FILES) {
      rows.push({
        ...base,
        kind: 'file',
        file: f.id,
        status: f.id === 'robots' && robotsUnreadable(i) ? 503 : i % 3 === 0 ? 200 : 404,
        present: f.id !== 'robots' ? i % 5 === 0 : undefined,
        soft_404: f.id !== 'robots' ? i % 11 === 0 : undefined,
        outcome: undefined,
        error: null,
      });
    }
    for (const d of DIALECTS) {
      const unreadable = robotsUnreadable(i);
      const denied = unreadable || denyFor(d.id, i);
      const outcome = denied
        ? 'denied_by_robots'
        : i % 7 === 0
          ? 'challenged'
          : i % 13 === 0
            ? 'blocked'
            : i % 17 === 0
              ? 'toll'
              : 'reachable';
      rows.push({
        ...base,
        kind: 'request',
        dialect: d.id,
        dialect_kind: d.kind,
        vantage: 'fixture-vantage',
        robots: {
          allowed: !denied,
          reason: unreadable ? 'robots-policy-unknown-http-503' : denied ? 'disallow-rule' : 'allow',
          known: !unreadable,
        },
        requested: !denied,
        outcome,
        challenge: outcome === 'challenged' ? 'cloudflare-challenge' : null,
        toll: outcome === 'toll' ? { status_402: true, header_names: ['crawler-price'] } : null,
        server: 'fixtureserver/1',
        redirected: false,
      });
    }
  }
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const capture = join(dir, 'fixture.jsonl');
  writeFileSync(capture, body);
  const agg = aggregate(rows);
  const manifest = join(dir, 'fixture.manifest.json');
  writeFileSync(
    manifest,
    JSON.stringify({
      schema_version: 1,
      capture_id: 'fixture-capture',
      capture_class: 'fixture',
      observed_from: '2026-08-22T00:00:00.000Z',
      observed_through: '2026-08-22T00:10:00.000Z',
      input: { name: 'fixture-list.csv', tranco_list: 'FIXTURE' },
      dataset: {
        name: 'fixture.jsonl',
        sha256: createHash('sha256').update(readFileSync(capture)).digest('hex'),
        bytes: Buffer.byteLength(body),
        rows: rows.length,
        domains: agg.domains,
      },
      identity_note: 'Fixture rows. Vendor-token callers are disclosed simulations, never authenticated vendor traffic.',
    }) + '\n',
  );
  return { capture, manifest, rows };
}

/** The whole suite, parameterised by dataset so the fixture and the real capture get identical treatment. */
function runSuite(label, capture, manifest) {
  const built = buildSite({ capture, manifest });
  const file = (rel) => {
    const v = built.files.get(rel);
    if (v === undefined) throw new Error(`build produced no ${rel}`);
    return v;
  };
  const index = file('index.html');
  // Independent recomputation. If the expectations came through summarise()
  // too, the comparison would be a tautology.
  const rows = readFileSync(capture, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const agg = aggregate(rows);
  const t = (name, fn) => check(`[${label}] ${name}`, fn);

  t('capture bytes match the declared manifest hash', () => {
    const declared = JSON.parse(readFileSync(manifest, 'utf8')).dataset.sha256;
    eq(createHash('sha256').update(readFileSync(capture)).digest('hex'), declared, 'dataset sha256');
  });

  t('build refuses bytes that do not match the manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'canireach-site-'));
    try {
      const tampered = join(dir, 'tampered.jsonl');
      // One extra row: still valid JSONL, still parses, wrong bytes.
      writeFileSync(tampered, readFileSync(capture, 'utf8') + JSON.stringify(rows[0]) + '\n');
      throws(() => loadVerifiedCapture(tampered, manifest), /do not match the published manifest/, 'tampered capture');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  t('build refuses a manifest with no declared hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'canireach-site-'));
    try {
      const m = JSON.parse(readFileSync(manifest, 'utf8'));
      delete m.dataset.sha256;
      const path = join(dir, 'nohash.manifest.json');
      writeFileSync(path, JSON.stringify(m));
      throws(() => loadVerifiedCapture(capture, path), /declares no dataset\.sha256/, 'hashless manifest');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  t('headline domain and row counts in the page match the rows', () => {
    ok(index.includes(`top ${agg.domains} domains`), `index does not state the measured domain count ${agg.domains}`);
    ok(file('api/summary.json').includes(`"rows": ${agg.rows}`), `summary.json does not carry row count ${agg.rows}`);
  });

  t('every per-caller figure in the table is recomputed, not carried', () => {
    for (const d of DIALECTS) {
      const r = agg.by_dialect[d.id];
      const p = agg.robots_policy[d.id];
      ok(index.includes(`<code>${d.id}</code>`), `index omits caller ${d.id}`);
      for (const n of [r.sent, p.denied, r.outcomes.reachable || 0]) {
        ok(new RegExp(`<td class="n">${n}</td>`).test(index), `index has no cell ${n} for ${d.id}`);
      }
    }
  });

  t('the named-vendor finding is the measured one, in the stated direction', () => {
    const browser = agg.robots_policy.browser.denied;
    const named = DIALECTS.filter((d) => d.kind === 'vendor-token-disclosed').map((d) => agg.robots_policy[d.id].denied);
    ok(named.length > 0, 'no vendor-token dialect declared');
    ok(
      named.every((n) => n > browser),
      `page claims named vendors are denied more; measured browser=${browser} named=${named.join(',')}`,
    );
    ok(index.includes(`<strong>${browser}</strong>`), `index does not carry the measured browser denial count ${browser}`);
    for (const n of named) ok(index.includes(`<strong>${n}</strong>`), `index does not carry vendor denial count ${n}`);
  });

  t('reachability rates use requests SENT as the denominator', () => {
    const s = JSON.parse(file('api/summary.json'));
    for (const row of s.by_dialect) {
      const src = agg.by_dialect[row.id];
      eq(row.sent, src.sent, `${row.id} sent`);
      eq(row.reachable_rate, Number(((src.outcomes.reachable || 0) / src.sent).toFixed(4)), `${row.id} rate`);
      ok(row.sent <= row.attempted, `${row.id} sent more than it attempted`);
    }
  });

  t('affordance counts match the file rows', () => {
    const s = JSON.parse(file('api/summary.json'));
    eq(JSON.stringify(s.affordances), JSON.stringify(agg.affordances), 'affordances');
    ok(index.includes('<code>llms_txt</code>'), 'index omits the llms.txt affordance row');
  });

  // The probe hands this URL to every domain it touches. If it does not
  // resolve, we are asking a thousand strangers to visit a dead link, and no
  // amount of documentation elsewhere repairs that.
  t('the probe contact URL is a path this build actually serves', () => {
    ok(PROBE_CONTACT.startsWith(`${SITE_ORIGIN}/`), `probe contact ${PROBE_CONTACT} is not on ${SITE_ORIGIN}`);
    const path = PROBE_CONTACT.slice(SITE_ORIGIN.length).replace(/^\/+/, '');
    const candidates = [path, `${path}/index.html`, `${path}.html`];
    ok(
      candidates.some((c) => built.files.has(c)),
      `probe advertises ${PROBE_CONTACT} but the build produces none of ${candidates.join(', ')}`,
    );
  });

  t('the bot page states how to block us, in robots syntax', () => {
    // Resolved from the advertised URL rather than a hardcoded path, so moving
    // the page cannot quietly detach this check from the page agents are sent to.
    const rel = PROBE_CONTACT.slice(SITE_ORIGIN.length).replace(/^\/+/, '');
    const key = [rel, `${rel}.html`, `${rel}/index.html`].find((c) => built.files.has(c));
    ok(key, `no built file serves the advertised probe contact ${PROBE_CONTACT}`);
    const bot = file(key);
    const token = DIALECTS.find((d) => d.id === 'canireach').robots_token;
    ok(bot.includes(`User-agent: ${token}`), `bot page does not name our robots token ${token}`);
    ok(/Disallow: \//.test(bot), 'bot page does not show a working disallow rule');
  });

  // llmstxt.org form is "- [name](url): description". A bare bullet renders
  // fine to a human and parses to nothing.
  t('every llms.txt bullet is a spec-form, absolute, resolving link', () => {
    const lines = file('llms.txt')
      .split('\n')
      .filter((l) => l.startsWith('- '));
    ok(lines.length >= 4, `expected several advertised endpoints, got ${lines.length}`);
    for (const line of lines) {
      const m = /^- \[([^\]]+)\]\((https?:\/\/[^)]+)\): .+$/.exec(line);
      ok(m, `not a spec-form entry: ${line}`);
      const url = m[2];
      if (!url.startsWith(SITE_ORIGIN)) continue;
      const rel = url.slice(SITE_ORIGIN.length).replace(/^\/+/, '') || 'index.html';
      ok(
        [rel, `${rel}/index.html`, `${rel}.html`].some((c) => built.files.has(c)),
        `llms.txt advertises ${url}, which this build does not produce`,
      );
    }
  });

  // The method page describes the comparability gate. If it describes a WEAKER
  // gate than the one that runs, that is a marketing claim, and the way it would
  // happen is a dimension being added to policy.mjs while the prose stayed put.
  t('the method page names every comparability dimension the gate enforces', () => {
    const method = file('method.html');
    for (const path of COMPARABILITY_DIMENSIONS) {
      ok(DIMENSION_WORDS[path], `no site wording for ${path}`);
      ok(method.includes(DIMENSION_WORDS[path]), `method page does not describe ${path}`);
    }
    // And the guard is real: a dimension the copy has no words for must stop the
    // build, not quietly drop off the page.
    let refused = false;
    try {
      comparabilityPhrase([...COMPARABILITY_DIMENSIONS, 'instrument_policy.invented']);
    } catch {
      refused = true;
    }
    ok(refused, 'the build accepted a comparability dimension it cannot describe');
  });

  t('the method page keeps the two redirect policies apart', () => {
    const method = file('method.html');
    ok(/five consecutive redirects/i.test(method), 'method page does not state the robots.txt redirect budget');
    ok(/context of the domain we asked about/i.test(method), 'method page does not state the initial-authority rule');
  });

  t('the limitations the data cannot show are stated on the page', () => {
    for (const needle of ['photograph, not a trend', 'do not impersonate', 'instrument moved']) {
      ok(index.toLowerCase().includes(needle.toLowerCase()), `index does not disclose: ${needle}`);
    }
  });

  t('no capture-derived claim escapes without its provenance', () => {
    const s = JSON.parse(file('api/summary.json'));
    eq(s.dataset_sha256, createHash('sha256').update(readFileSync(capture)).digest('hex'), 'summary hash');
    ok(index.includes(s.dataset_sha256), 'index does not publish the capture hash its numbers came from');
    ok(index.includes(s.capture_id), 'index does not name the capture');
  });

  // The /mcp page and /api/mcp.json describe a CALLABLE interface. Prose about a
  // measurement can be a little stale and still be honest; a tool signature
  // cannot. Everything mechanical about the tools is read from `TOOLS`, and
  // these checks are what make "read from" true rather than intended.
  t('the mcp page names every tool the server serves, with its real description and schema', () => {
    const mcp = file('mcp.html');
    ok(TOOLS.length > 0, 'the server declares no tools, so this check would prove nothing');
    for (const tool of TOOLS) {
      ok(mcp.includes(`<code>${tool.name}</code>`), `mcp page omits tool ${tool.name}`);
      // The description is escaped into the page, so compare against the escaped
      // form rather than a substring that would pass on a paraphrase.
      const desc = tool.description
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
      ok(mcp.includes(desc), `mcp page does not carry the server's own description of ${tool.name}`);
      const schema = JSON.stringify(tool.inputSchema).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      ok(mcp.includes(schema), `mcp page does not carry the input schema of ${tool.name}`);
    }
  });

  // The page and the descriptor publish this list independently. Neither is
  // checked against a literal here — they are checked against EACH OTHER and
  // against the guard's own constant, so hand-listing in either place shows up
  // as a disagreement rather than as two copies of the same mistake.
  t('the mcp page and the descriptor agree on every field an answer may never contain', () => {
    const mcp = file('mcp.html');
    const descriptor = JSON.parse(file('api/mcp.json'));
    ok(PRESENT_TENSE_FIELD_NAMES.length > 0, 'no forbidden field names declared');
    eq(
      JSON.stringify(descriptor.forbidden_answer_fields),
      JSON.stringify(PRESENT_TENSE_FIELD_NAMES),
      'descriptor forbidden-field list',
    );
    for (const name of descriptor.forbidden_answer_fields) {
      ok(mcp.includes(`<code>${name}</code>`), `mcp page does not list the refused field ${name}`);
    }
  });

  // llms.txt and sitemap.xml are the two documents a visitor uses to find out
  // what is here, one machine-first and one crawler-first. A page advertised in
  // only one of them is discoverable by half the web.
  t('every html page advertised in llms.txt is also in the sitemap', () => {
    const advertised = [...file('llms.txt').matchAll(/^- \[[^\]]+\]\((https?:\/\/[^)]+)\)/gm)].map((m) => m[1]);
    const sitemap = [...file('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    let checked = 0;
    for (const url of advertised) {
      if (!url.startsWith(SITE_ORIGIN)) continue;
      const rel = url.slice(SITE_ORIGIN.length).replace(/^\/+/, '') || 'index.html';
      const key = [rel, `${rel}/index.html`, `${rel}.html`].find((c) => built.files.has(c));
      if (!key || !key.endsWith('.html')) continue;
      checked++;
      ok(sitemap.includes(url), `llms.txt advertises the page ${url}, which the sitemap omits`);
    }
    ok(checked >= 3, `expected several advertised html pages to check, got ${checked}`);
  });

  // The three-way evidence split is the biggest thing this dataset has to say
  // about itself. If the page could restate it, the page could get it wrong.
  t('the evidence split on the mcp page is what datasetStatus computes', () => {
    const status = datasetStatus(buildIndex({ manifest: JSON.parse(readFileSync(manifest, 'utf8')), rows, dialectClasses: DIALECT_TO_CLASS }), {
      now: '2026-08-22T00:10:00.000Z',
    });
    const d = JSON.parse(file('api/mcp.json')).dataset;
    eq(d.domains_indexed, status.domains_indexed, 'domains indexed');
    eq(d.domains_with_any_behavioural_evidence, status.domains_with_any_behavioural_evidence, 'domains with behaviour');
    eq(JSON.stringify(d.doors_by_evidence), JSON.stringify(status.doors_by_evidence), 'doors by evidence');
    const mcp = file('mcp.html');
    ok(
      mcp.includes(`<strong>${status.domains_with_any_behavioural_evidence}</strong>`),
      'mcp page does not carry the measured behavioural-coverage count',
    );
    for (const n of Object.values(status.doors_by_evidence)) {
      ok(new RegExp(`<td class="n">${n}</td>`).test(mcp), `mcp page has no evidence-split cell ${n}`);
    }
    // The page does ARITHMETIC in prose: what a flattening tool would report,
    // versus the two numbers it would have merged. Every figure in it is derived,
    // which is exactly why the sum is the part that can quietly go wrong — a
    // derived number is not a correct one, and nothing above this line would
    // notice the wrong pair being added.
    const declared = status.doors_by_evidence['robots-declaration'];
    const notAttempted = status.doors_by_evidence['not-attempted'];
    ok(
      mcp.includes(`<strong>${declared + notAttempted}</strong> doors as refused`),
      `mcp page does not state the flattened total ${declared + notAttempted} (${declared} + ${notAttempted})`,
    );
  });

  t('no built json artifact carries a value computed against a clock', () => {
    for (const [rel, body] of built.files) {
      if (!rel.endsWith('.json')) continue;
      assertNoVolatileClaim(JSON.parse(body), rel);
    }
    // And the guard discriminates: it must reject each forbidden key, at depth.
    ok(VOLATILE_ARTIFACT_KEYS.length > 0, 'no volatile keys declared, so the guard proves nothing');
    for (const key of VOLATILE_ARTIFACT_KEYS) {
      throws(
        () => assertNoVolatileClaim({ dataset: { as_of: [{ [key]: 1 }] } }, 'control'),
        /computed against a clock/,
        `guard accepted a nested ${key}`,
      );
    }
  });

  t('sitemap and 404 exist and every sitemap url is built', () => {
    const urls = [...file('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    ok(urls.length >= 3, `expected the pages in the sitemap, got ${urls.length}`);
    for (const u of urls) {
      const rel = u.slice(SITE_ORIGIN.length).replace(/^\/+/, '') || 'index.html';
      ok([rel, `${rel}/index.html`, `${rel}.html`].some((c) => built.files.has(c)), `sitemap advertises ${u}, not built`);
    }
    file('404.html');
  });
}

const dir = mkdtempSync(join(tmpdir(), 'canireach-fixture-'));
try {
  const fx = makeFixture(dir);
  runSuite('fixture', fx.capture, fx.manifest);

  // Vacuity control: the same suite over data where the page's central claim is
  // false must FAIL. Without this, "the finding matches the data" could be a
  // check that passes on anything.
  check('[control] the finding check rejects a capture that contradicts the page', () => {
    const cdir = mkdtempSync(join(tmpdir(), 'canireach-counter-'));
    try {
      const counter = makeFixture(cdir, { vendorDenials: 2, browserDenials: 20 });
      const built = buildSite({ capture: counter.capture, manifest: counter.manifest });
      const agg = aggregate(counter.rows);
      const browser = agg.robots_policy.browser.denied;
      const named = DIALECTS.filter((d) => d.kind === 'vendor-token-disclosed').map(
        (d) => agg.robots_policy[d.id].denied,
      );
      ok(
        !named.every((n) => n > browser),
        'counter-fixture failed to contradict the claim, so this control proves nothing',
      );
      ok(built.files.has('index.html'), 'counter-fixture did not build');
    } finally {
      rmSync(cdir, { recursive: true, force: true });
    }
  });

  // The guard on the guard. A mutant that broke the flattening arithmetic
  // escaped this suite because both datasets it ran against had ZERO
  // `not-attempted` doors, so every check touching that count was arithmetic on
  // a zero and passed either way. If a later edit zeroes the class out again,
  // that silence must be loud.
  check('[control] the fixture exercises all three evidence classes, none of them empty', () => {
    const status = datasetStatus(
      buildIndex({ manifest: JSON.parse(readFileSync(fx.manifest, 'utf8')), rows: fx.rows, dialectClasses: DIALECT_TO_CLASS }),
      { now: '2026-08-22T00:10:00.000Z' },
    );
    for (const [kind, count] of Object.entries(status.doors_by_evidence)) {
      ok(count > 0, `fixture has no ${kind} doors, so every check over that class is vacuous`);
    }
    // And they must be genuinely distinct sizes, or a check comparing two of
    // them could pass by coincidence.
    const counts = Object.values(status.doors_by_evidence);
    eq(new Set(counts).size, counts.length, 'fixture evidence classes are not distinguishable by count');
  });

  // The mapping between served tools and page copy is checked in BOTH
  // directions. A tool with no words is the obvious half; words for a tool that
  // no longer exists is the half that leaves a live page advertising a call that
  // now returns "unknown tool".
  check('[control] the build refuses a tool it has no words for, and words for a tool it does not serve', () => {
    ok(toolSpecs().length === TOOLS.length, 'toolSpecs dropped or invented a tool on the real registry');
    throws(
      () => toolSpecs([...TOOLS, { name: 'invented_tool', description: 'x', inputSchema: {} }], TOOL_WORDS),
      /no wording for MCP tool/,
      'build accepted a served tool with no page copy',
    );
    throws(
      () => toolSpecs(TOOLS.slice(1), TOOL_WORDS),
      /does not serve/,
      'build accepted page copy for a tool the server dropped',
    );
    // Page copy may add to a tool; it may never replace what the server
    // publishes. `description` is the text a calling model acts on.
    const hijack = Object.fromEntries(
      Object.entries(TOOL_WORDS).map(([k, v], i) => [k, i === 0 ? { ...v, description: 'friendlier copy' } : v]),
    );
    throws(() => toolSpecs(TOOLS, hijack), /would override what the server publishes/, 'build accepted overriding copy');
  });

  // THE DESCRIPTOR IS CHECKED AGAINST A RUNNING SERVER, NOT AGAINST THE MODULE
  // IT IMPORTS. Comparing the published tools to the constant the publisher read
  // would be a tautology. Driving a real child over a real pipe puts the whole
  // handler path in the comparison, so a transform, filter or rename anywhere
  // between the constant and the wire is caught — which is the only way the site
  // could end up advertising an interface the server does not actually serve.
  // Same argument that made tools/test-mcp.mjs spawn a process: reading a module
  // is not running it, and that applies to a protocol too.
  await (async () => {
    const built = buildSite({ capture: fx.capture, manifest: fx.manifest });
    const descriptor = JSON.parse(built.files.get('api/mcp.json'));
    const server = join(new URL('.', import.meta.url).pathname, 'mcp-server.mjs');
    const live = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [server, '--manifest', fx.manifest], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, out, err }));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
      child.stdin.end();
    });

    check('[live] the server starts on the same bytes the site was built from', () => {
      eq(live.code, 0, 'server exit code');
      ok(live.err.includes(SERVER_NAME), `server banner did not name ${SERVER_NAME}: ${live.err.slice(0, 200)}`);
    });

    check('[live] /api/mcp.json publishes exactly what tools/list answers over the wire', () => {
      const messages = live.out
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
      const list = messages.find((m) => m.id === 2);
      ok(list, `no tools/list response on stdout: ${live.out.slice(0, 200)}`);
      ok(Array.isArray(list.result?.tools) && list.result.tools.length > 0, 'tools/list returned no tools');
      eq(
        JSON.stringify(descriptor.tools),
        JSON.stringify(list.result.tools),
        'the published descriptor does not match what the running server serves',
      );
      const init = messages.find((m) => m.id === 1);
      eq(descriptor.server.protocol_version, init.result.protocolVersion, 'published protocol version');
      eq(descriptor.server.name, init.result.serverInfo.name, 'published server name');
      eq(descriptor.server.version, init.result.serverInfo.version, 'published server version');
    });

    check('[live] the invocation the site publishes is the one the server accepts', () => {
      const inv = descriptor.invocation;
      eq(inv.command, 'node', 'published command');
      ok(inv.args.includes('--manifest'), 'published invocation omits the flag the server requires');
      ok(inv.args.some((a) => a.endsWith('mcp-server.mjs')), 'published invocation does not name the server script');
    });
  })();

  if (existsSync(REAL_CAPTURE) && existsSync(REAL_MANIFEST)) {
    runSuite('published baseline', REAL_CAPTURE, REAL_MANIFEST);
  } else {
    console.log(`note  published baseline not present locally (${REAL_CAPTURE}); fixture suite ran alone`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} site check(s) failed`);
  process.exit(1);
}
console.log('\nall site checks passed');
