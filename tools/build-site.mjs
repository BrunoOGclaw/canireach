// The public surface, generated from published bytes.
//
// RAIL: no number on this site is typed by a human or carried forward from a
// previous build. Every figure is recomputed by aggregate() from the capture's
// own rows, and the build REFUSES (exit 3) unless those rows hash to the
// SHA-256 recorded in the capture's published manifest. A site that publishes
// access measurements has exactly one thing to sell — that its numbers came
// from the bytes it says they came from — so that link is mechanical here
// rather than remembered.
//
// Usage: node tools/build-site.mjs [--capture FILE] [--manifest FILE] [--out DIR]

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { aggregate } from './aggregate.mjs';
import { loadVerifiedCapture } from './capture.mjs';
import { DIALECTS, PROBE_CONTACT } from './dialects.mjs';
import { COMPARABILITY_DIMENSIONS } from './policy.mjs';
import { PRESENT_TENSE_FIELD_NAMES, buildIndex, datasetStatus } from './lookup.mjs';
import { DIALECT_TO_CLASS } from './reports.mjs';
import { PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION, TOOLS } from './mcp-server.mjs';

export const SITE_ORIGIN = 'https://canireach.ai';

/**
 * Plain-English name for each comparability dimension, for the method page.
 *
 * The page used to restate the list in prose, which meant adding a dimension
 * silently narrowed what the site claimed to check — the fifth or sixth time
 * this repository has found "a list covers what its author thought of". The
 * phrases are still hand-written, because a dotted path is not English, but the
 * SET is derived and the build REFUSES a dimension it has no words for. A page
 * describing a weaker gate than the one that runs is a marketing claim.
 */
export const DIMENSION_WORDS = {
  'vantage.class': 'vantage class',
  'observation_window.slot': 'observation slot',
  'input.sha256': 'input list',
  'instrument_policy.row_schema_version': 'row schema',
  'instrument_policy.robots_unavailable': 'robots-unavailable policy',
  'instrument_policy.redirects': 'probe-target redirect policy',
  'instrument_policy.robots_redirects': 'robots.txt redirect policy',
  'instrument_policy.denial_gate': 'denial gate',
  'instrument_policy.dialects': 'caller set',
};

export function comparabilityPhrase(dimensions = COMPARABILITY_DIMENSIONS) {
  const missing = dimensions.filter((path) => !DIMENSION_WORDS[path]);
  if (missing.length) {
    const err = new Error(`site copy has no wording for comparability dimension(s): ${missing.join(', ')}`);
    err.exitCode = 3;
    throw err;
  }
  const words = dimensions.map((path) => DIMENSION_WORDS[path]);
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * Plain-English framing for each MCP tool, for the /mcp page.
 *
 * Same construction as DIMENSION_WORDS above and for the same reason. The tool
 * NAMES, DESCRIPTIONS and INPUT SCHEMAS on the page are read from `TOOLS` in
 * mcp-server.mjs — the page never restates them, because a page restating a
 * callable interface is a page that will eventually advertise a signature the
 * server stopped serving. Only the surrounding English is written here, and the
 * mapping is checked BOTH ways: a tool with no words stops the build, and words
 * for a tool the server does not serve stop it too. The second direction is the
 * one that catches a REMOVED tool leaving live copy behind.
 */
export const TOOL_WORDS = {
  reachability_lookup: {
    heading: 'Ask about one host',
    when: 'Call this before you spend a request on a domain you have not touched before, or after one refuses you and you want to know whether a detour was published.',
    example: { name: 'reachability_lookup', arguments: { domain: 'cloudflare.com' } },
  },
  dataset_status: {
    heading: 'Ask what the answers are worth',
    // No proportion is asserted here on purpose. It moves with the capture: the
    // automated series fails closed on an unreadable robots.txt and the
    // residential baseline failed open, which is a swing of thousands of doors.
    // A sentence naming a share would be a claim about one capture printed on a
    // page built from whichever capture is current.
    when: 'Call this once at the start of a session. It tells you which capture is loaded and how much of it is behaviour rather than doors this instrument declined to knock on — a proportion that moves with the capture, sometimes enormously.',
    example: { name: 'dataset_status', arguments: {} },
  },
};

export function toolSpecs(tools = TOOLS, words = TOOL_WORDS) {
  const refuse = (message) => {
    const err = new Error(message);
    err.exitCode = 3;
    throw err;
  };
  const served = tools.map((t) => t.name);
  const missing = served.filter((name) => !words[name]);
  if (missing.length) refuse(`site copy has no wording for MCP tool(s) the server serves: ${missing.join(', ')}`);
  const orphaned = Object.keys(words).filter((name) => !served.includes(name));
  if (orphaned.length) refuse(`site copy describes MCP tool(s) the server does not serve: ${orphaned.join(', ')}`);
  // The merge below lets page copy ADD to a tool. It must never let page copy
  // REPLACE what the server publishes — a `description` key here would silently
  // win the spread, and the description is the text a calling model acts on. A
  // mutant proved the suite catches that; this makes it impossible instead,
  // which is the difference between a defect that is detected and one that
  // cannot be written.
  for (const t of tools) {
    const clobbered = Object.keys(words[t.name]).filter((k) => k in t);
    if (clobbered.length) {
      refuse(`site copy for MCP tool '${t.name}' would override what the server publishes: ${clobbered.join(', ')}`);
    }
  }
  return tools.map((t) => ({ ...t, ...words[t.name] }));
}

/**
 * Keys no BUILT artifact may carry.
 *
 * `age_minutes` and `freshness` are honest in a lookup answer: that answer is
 * computed at call time against an explicit `now`. Baked into a static file
 * behind a CDN cache they are stale the moment they are written — the file
 * would be asserting its own recency using a clock that stopped at build time.
 * This is #17's present-tense refusal applied one layer up, to the build.
 */
export const VOLATILE_ARTIFACT_KEYS = ['age_minutes', 'freshness'];

export function assertNoVolatileClaim(value, path = 'artifact') {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoVolatileClaim(v, `${path}[${i}]`));
    return value;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (VOLATILE_ARTIFACT_KEYS.includes(key)) {
        const err = new Error(`${path}.${key} is computed against a clock; a static artifact cannot carry it`);
        err.exitCode = 3;
        throw err;
      }
      assertNoVolatileClaim(value[key], `${path}.${key}`);
    }
  }
  return value;
}

const DEFAULT_CAPTURE = 'data/probes/2026-08-22T0815Z.jsonl';
const DEFAULT_MANIFEST = 'data/probes/2026-08-22T0815Z.final.manifest.json';

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');

// The bytes-match-the-manifest guarantee now lives in tools/capture.mjs, because
// tools/compare.mjs needs the identical check to admit the immutable v1 baseline.
// Re-exported so this module's published surface is unchanged.
export { loadVerifiedCapture };

/**
 * The dialect table is the finding, so it is derived rather than narrated: for
 * each identity we present, how often were we allowed to ask, and how often did
 * we get an answer. `sent` is the denominator on purpose — dividing by attempts
 * would score our own robots compliance as the web refusing us.
 */
function dialectRows(agg) {
  return DIALECTS.map((d) => {
    const row = agg.by_dialect[d.id];
    const policy = agg.robots_policy[d.id];
    if (!row || !policy) throw new Error(`capture has no rows for declared dialect ${d.id}`);
    const o = row.outcomes;
    return {
      id: d.id,
      kind: d.kind,
      attempted: row.attempted,
      sent: row.sent,
      robots_denied: policy.denied,
      reachable: o.reachable || 0,
      challenged: o.challenged || 0,
      blocked: o.blocked || 0,
      reachable_rate: row.sent ? Number(((o.reachable || 0) / row.sent).toFixed(4)) : null,
    };
  });
}

function summarise(agg, manifest, sha256) {
  const rows = dialectRows(agg);
  const named = rows.filter((r) => r.kind === 'vendor-token-disclosed');
  const browser = rows.find((r) => r.id === 'browser');
  const ours = rows.find((r) => r.id === 'canireach');
  return {
    capture_id: manifest.capture_id,
    capture_class: manifest.capture_class,
    observed_from: manifest.observed_from,
    observed_through: manifest.observed_through,
    vantage: agg.vantages,
    input_list: manifest.input?.name ?? null,
    tranco_list: manifest.input?.tranco_list ?? null,
    dataset_sha256: sha256,
    domains: agg.domains,
    rows: agg.rows,
    requests_sent: agg.requests_sent,
    reachable_rate_of_sent: agg.reachable_rate_of_sent,
    by_dialect: rows,
    // The comparison the project exists to make, stated as two derived numbers
    // rather than a sentence: what does wearing a recognised vendor name cost?
    named_vendor_penalty: {
      browser_robots_denied: browser.robots_denied,
      named_vendor_robots_denied: named.map((r) => ({ dialect: r.id, denied: r.robots_denied })),
      browser_reachable_rate: browser.reachable_rate,
      unrecognised_agent_reachable_rate: ours.reachable_rate,
      named_vendor_reachable_rate: named.map((r) => ({ dialect: r.id, rate: r.reachable_rate })),
    },
    affordances: agg.affordances,
    challenges: agg.challenges,
    toll: agg.toll,
    outcomes: agg.outcomes,
    robots_txt: agg.robots_txt,
    limitations: {
      identity: manifest.identity_note ?? null,
      vantage_note:
        'This capture was taken from a residential vantage with robots-unavailable failing open. Automated captures run from GitHub-hosted dynamic egress with robots-unavailable failing closed. Those are different instruments and the repository withholds cross-capture deltas until every comparability dimension matches.',
      single_capture:
        'One capture is a photograph, not a trend. No before/after claim is published until a second comparable capture exists.',
    },
    source: {
      repository: 'https://github.com/BrunoOGclaw/canireach',
      methodology: 'https://github.com/BrunoOGclaw/canireach/blob/main/METHODOLOGY.md',
      releases: 'https://github.com/BrunoOGclaw/canireach/releases',
    },
  };
}

const page = (title, description, body, canonical) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<link rel="stylesheet" href="/style.css">
<link rel="alternate" type="application/json" href="/api/summary.json" title="Summary (JSON)">
</head>
<body>
<header>
<a class="wordmark" href="/">can<span>i</span>reach</a>
<nav><a href="/method">Method</a> <a href="/mcp">MCP tool</a> <a href="/bot">Our bot</a> <a href="/api/summary.json">JSON</a> <a href="https://github.com/BrunoOGclaw/canireach">Source</a></nav>
</header>
<main>
${body}
</main>
<footer>
<p>Behavioral access measurements for the agent web. Numbers on this page are recomputed at build time from the published capture; nothing here is hand-maintained.</p>
<p><a href="/llms.txt">llms.txt</a> · <a href="/api/summary.json">summary.json</a> · <a href="/api/baseline.json">baseline.json</a> · <a href="https://github.com/BrunoOGclaw/canireach">source</a></p>
</footer>
</body>
</html>
`;

function indexBody(s) {
  const rows = s.by_dialect
    .map(
      (r) => `<tr>
<td><code>${esc(r.id)}</code><br><span class="muted">${esc(r.kind)}</span></td>
<td class="n">${r.sent}</td>
<td class="n">${r.robots_denied}</td>
<td class="n">${r.reachable}</td>
<td class="n">${pct(r.reachable, r.sent)}</td>
<td class="n">${r.challenged}</td>
<td class="n">${r.blocked}</td>
</tr>`,
    )
    .join('\n');

  const aff = Object.entries(s.affordances)
    .map(
      ([id, a]) =>
        `<tr><td><code>${esc(id)}</code></td><td class="n">${a.present}</td><td class="n">${pct(a.present, a.checked)}</td><td class="n">${a.soft_404}</td></tr>`,
    )
    .join('\n');

  const ch = Object.entries(s.challenges)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td class="n">${v}</td></tr>`)
    .join('\n');

  return `<h1>Can I reach it?</h1>
<p class="lede">An access map of the agent web built from behavior, not declarations. We ask the top ${s.domains} domains the same question as five different callers and record what actually comes back: the status, the challenge, the toll, and whether the site drew us a detour.</p>

<section class="card">
<h2>The finding</h2>
<p>Being an agent is cheap. Being a <em>recognised</em> agent is expensive.</p>
<p>An ordinary browser was denied by <code>robots.txt</code> on <strong>${s.named_vendor_penalty.browser_robots_denied}</strong> of ${s.domains} domains. The same request wearing a published vendor token was denied on ${s.named_vendor_penalty.named_vendor_robots_denied.map((d) => `<strong>${d.denied}</strong> (<code>${esc(d.dialect)}</code>)`).join(' and ')}.</p>
<p>An agent that identified itself honestly but under a name nobody has heard of was reached <strong>${pct(s.by_dialect.find((r) => r.id === 'canireach').reachable, s.by_dialect.find((r) => r.id === 'canireach').sent)}</strong> of the time — slightly <em>better</em> than the browser control at ${pct(s.by_dialect.find((r) => r.id === 'browser').reachable, s.by_dialect.find((r) => r.id === 'browser').sent)}. The penalty attaches to the name on the door, not to being automated.</p>
</section>

<h2>By caller</h2>
<table>
<thead><tr><th>Caller</th><th class="n">Asked</th><th class="n">robots denied</th><th class="n">Reached</th><th class="n">Rate</th><th class="n">Challenged</th><th class="n">Blocked</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<p class="muted">“Asked” counts requests we actually sent. Where <code>robots.txt</code> denied us we did not send one, so those are excluded from the rate rather than counted as the site refusing.</p>

<h2>Who is drawing detours</h2>
<p>Of ${s.domains} domains, these publish a machine-readable affordance an agent can follow instead of guessing.</p>
<table>
<thead><tr><th>File</th><th class="n">Present</th><th class="n">Share</th><th class="n">Soft 404</th></tr></thead>
<tbody>
${aff}
</tbody>
</table>
<p class="muted">Soft 404s are sites answering 200 to a path that does not exist — counted, not discarded, because a site that says yes to everything is its own kind of unreachable.</p>

<h2>What stopped us</h2>
<table>
<thead><tr><th>Challenge</th><th class="n">Responses</th></tr></thead>
<tbody>
${ch}
</tbody>
</table>
<p>${s.toll.status_402 ?? 0} responses asked for money outright (HTTP 402).</p>

<section class="card warn">
<h2>What this is not</h2>
<ul>
<li><strong>One capture is a photograph, not a trend.</strong> ${esc(s.limitations.single_capture)}</li>
<li><strong>We do not impersonate.</strong> ${esc(s.limitations.identity ?? '')}</li>
<li><strong>The instrument moved.</strong> ${esc(s.limitations.vantage_note)}</li>
</ul>
</section>

<h2>Provenance</h2>
<dl class="prov">
<dt>Capture</dt><dd><code>${esc(s.capture_id)}</code> (${esc(s.capture_class)})</dd>
<dt>Observed</dt><dd>${esc(s.observed_from)} → ${esc(s.observed_through)}</dd>
<dt>Input</dt><dd>Tranco list <code>${esc(s.tranco_list ?? 'unrecorded')}</code>, ${s.domains} domains</dd>
<dt>Rows</dt><dd>${s.rows}</dd>
<dt>SHA-256</dt><dd><code class="hash">${esc(s.dataset_sha256)}</code></dd>
<dt>Bytes</dt><dd><a href="${esc(s.source.releases)}">published releases</a></dd>
</dl>
<p>Recompute these numbers yourself: download the capture from the release, then <code>node tools/aggregate.mjs &lt;capture.jsonl&gt;</code>.</p>`;
}

function methodBody(s) {
  return `<h1>Method</h1>
<p class="lede">We probe status, not content. Nothing here reads a page body.</p>
<h2>What one capture does</h2>
<p>For each of ${s.domains} domains we fetch <code>robots.txt</code> and check four agent affordances, then attempt one request as each of five callers. One append-only JSONL row per observation.</p>
<h2>Rails</h2>
<ul>
<li><strong>No evasion.</strong> We do not solve CAPTCHAs, rotate identities to get around a block, or retry to defeat a rate limit. A block is the measurement.</li>
<li><strong>No impersonation.</strong> Vendor-token callers append a disclosure naming this project. They are labelled simulations everywhere they appear, and that is a stated limitation of the instrument, not a footnote.</li>
<li><strong>We obey robots.</strong> Where it denies a caller we do not send that caller's request, and we report that separately from a refusal.</li>
<li><strong>No bodies, no cookies, no header maps.</strong> Rows keep policy and response metadata only.</li>
</ul>
<h2>Denominators</h2>
<p>The headline reachability rate is over requests <em>sent</em>. Dividing by all attempts would fold our own compliance into the web's hostility and make the web look more hostile than it is.</p>
<h2>Comparability</h2>
<p>${esc(s.limitations.vantage_note)}</p>
<p>The repository refuses to emit a cross-capture delta unless ${esc(comparabilityPhrase())} all match. An unrecorded dimension never counts as agreement with another unrecorded dimension.</p>
<p>The probe follows up to five consecutive redirects for <code>robots.txt</code>, as RFC 9309 requires, and applies the policy it finds in the context of the domain we asked about. It follows none for the page it is measuring: that destination has not been checked against robots itself. Those two policies are recorded separately, so relaxing one cannot hide behind the other.</p>
<h2>Full detail</h2>
<p><a href="${esc(s.source.methodology)}">METHODOLOGY.md</a> · <a href="${esc(s.source.repository)}">source</a> · <a href="${esc(s.source.releases)}">every capture, with hashes</a></p>`;
}

/**
 * The machine descriptor for the MCP server.
 *
 * An agent should be able to decide whether to wire this server up without
 * first completing a stdio handshake, so everything a `tools/list` would return
 * is here — read from the server module, never copied. `forbidden_answer_fields`
 * is derived too: it tells a calling model, up front, the field names it will
 * never be given, which is more useful to it than the prose explaining why.
 */
function mcpDescriptor(s, coverage) {
  return {
    server: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      protocol_version: PROTOCOL_VERSION,
      transport: 'stdio — JSON-RPC 2.0, newline-delimited',
    },
    invocation: {
      command: 'node',
      args: ['tools/mcp-server.mjs', '--manifest', '<capture>.final.manifest.json'],
      source: s.source.repository,
      captures: s.source.releases,
      note: 'Clone the repository and download any capture from the releases page. The server reads local bytes, verifies them against the SHA-256 its manifest publishes, and refuses to start if they disagree. It opens no socket.',
    },
    tools: TOOLS,
    dataset: {
      capture_id: s.capture_id,
      dataset_sha256: s.dataset_sha256,
      observed_from: s.observed_from,
      observed_through: s.observed_through,
      ...coverage,
    },
    // Each of these is held by a test, and the file is named because "covered
    // somewhere" is how a claim survives its own coverage disappearing. The
    // no-network rail and the present-tense guard live in test-lookup.mjs (which
    // scans both module sources for `fetch(`, sockets and a probe import); the
    // unknown-host and behaviour-only rails are driven over the wire in
    // test-mcp.mjs. I wrote "all four are in test-mcp.mjs" here first and it was
    // wrong — the diff review is what caught it.
    refusals: [
      'No on-demand probing. The server has no network access and never imports the prober, so it cannot be pointed at a third party as a scanner.',
      'No parent-domain fallback. api.example.com is not example.com, and an unprobed host answers `unknown` rather than an inference.',
      'No present-tense field in any answer. Behaviour is `last_outcome` welded to when it was observed.',
      'A door is only reported as behaviour if a request was actually sent to it.',
    ],
    forbidden_answer_fields: PRESENT_TENSE_FIELD_NAMES,
  };
}

function mcpBody(s, coverage) {
  const specs = toolSpecs();
  const tools = specs
    .map(
      (t) => `<section class="card">
<h3>${esc(t.heading)} — <code>${esc(t.name)}</code></h3>
<p>${esc(t.description)}</p>
<p class="muted">${esc(t.when)}</p>
<pre><code>${esc(JSON.stringify(t.example, null, 2))}</code></pre>
<p class="muted">Input schema: <code>${esc(JSON.stringify(t.inputSchema))}</code></p>
</section>`,
    )
    .join('\n');

  const c = coverage;
  const doors = c.doors_by_evidence;
  const totalDoors = Object.values(doors).reduce((a, b) => a + b, 0);

  return `<h1>The MCP tool</h1>
<p class="lede">A tool your agent calls in its own loop: <em>what did canireach last measure at this domain, through which door, and is there a detour?</em> Read-only, no network, answers from published capture bytes.</p>

<h2>Run it</h2>
<pre><code>git clone ${esc(s.source.repository)}
# download any capture from ${esc(s.source.releases)}
node tools/mcp-server.mjs --manifest &lt;capture&gt;.final.manifest.json</code></pre>
<p>No dependencies and no <code>package.json</code>; the protocol is a few message shapes. The full descriptor, including every tool's input schema, is at <a href="/api/mcp.json">/api/mcp.json</a> — readable without completing a handshake.</p>

<h2>Tools</h2>
${tools}

<section class="card warn">
<h2>What it will never tell you</h2>
<p>Every answer describes a <strong>past measurement</strong>, so no field in one is present-tense. These names are refused by a guard, not by a convention:</p>
<p>${PRESENT_TENSE_FIELD_NAMES.map((n) => `<code>${esc(n)}</code>`).join(', ')}</p>
<p>The one that matters is <code>allowed</code>. It is the probe row's own <code>robots.txt</code> field name, so re-emitting the row shape is the natural way to introduce it — and an agent reading <code>allowed: false</code> on a door where <code>robots.txt</code> was merely <em>unreadable</em> would be reading our own fail-closed default as the site's answer.</p>
</section>

<h2>How much of this is evidence</h2>
<p>Of ${c.domains_indexed} domains in the current capture, <strong>${c.domains_with_any_behavioural_evidence}</strong> carry any behavioural evidence at all — a request we actually sent and watched come back.</p>
<table>
<thead><tr><th>Door</th><th class="n">Count</th><th class="n">Share</th><th>What it means</th></tr></thead>
<tbody>
<tr><td><code>behaviour</code></td><td class="n">${doors.behaviour}</td><td class="n">${pct(doors.behaviour, totalDoors)}</td><td>We sent a request and observed the result.</td></tr>
<tr><td><code>robots-declaration</code></td><td class="n">${doors['robots-declaration']}</td><td class="n">${pct(doors['robots-declaration'], totalDoors)}</td><td>We read <code>robots.txt</code> and it disallows this caller. The site's own policy.</td></tr>
<tr><td><code>not-attempted</code></td><td class="n">${doors['not-attempted']}</td><td class="n">${pct(doors['not-attempted'], totalDoors)}</td><td>We could not read <code>robots.txt</code> and failed closed. A fact about us.</td></tr>
</tbody>
</table>
<p class="muted">${esc(c.note)}</p>
<p>The tool keeps those three apart in every answer, and <code>dataset_status</code> reports the split. A tool that flattened them would report <strong>${doors['robots-declaration'] + doors['not-attempted']}</strong> doors as refused, when <strong>${doors['robots-declaration']}</strong> of those are the site's own published policy and <strong>${doors['not-attempted']}</strong> are this instrument declining to knock. That second group carries no information about the host at all: any hostility read from it is hostility we manufactured ourselves.</p>
<p class="muted">That split swings hard between captures, which is why it is published rather than summarised: this capture ran from a residential vantage with an unreadable <code>robots.txt</code> failing <em>open</em>, and the automated nightly series fails <em>closed</em>. Same instrument family, very different denominators. See <a href="/method">method</a>.</p>

<h2>Rails</h2>
<ul>
<li><strong>It cannot probe.</strong> There is no <code>fetch</code> in the server or its lookup module and neither imports the prober. A reachability tool that probed on demand would be an on-request scanner aimed at whatever third party the caller names.</li>
<li><strong>No parent-domain fallback.</strong> <code>api.example.com</code> is not <code>example.com</code>; an unprobed host answers <code>unknown</code>.</li>
<li><strong>Everything it serves is hashed.</strong> The server refuses to start unless the capture's bytes match the SHA-256 its manifest published.</li>
</ul>
<p><a href="/api/mcp.json">/api/mcp.json</a> · <a href="/method">method</a> · <a href="${esc(s.source.repository)}">source</a></p>`;
}

function botBody() {
  const d = DIALECTS.find((x) => x.id === 'canireach');
  return `<h1>About our probe</h1>
<p class="lede">If you found this page in your logs, one of our requests sent you here on purpose.</p>
<h2>What it is</h2>
<p>We send at most a handful of requests per domain per night to measure whether the agent web is reachable. We read status codes, challenge markers and a few well-known files. <strong>We do not read, store or republish your page content.</strong> No bodies, no cookies.</p>
<h2>User-agent</h2>
<pre><code>${esc(d.ua)}</code></pre>
<h2>How to block us</h2>
<p>Put this in <code>/robots.txt</code> and we will stop sending requests to you. We check before every capture and we honour it.</p>
<pre><code>User-agent: CanIReachBot
Disallow: /</code></pre>
<p>You will still appear in the dataset, recorded as having denied us — that is an honest measurement of your policy, and it is the outcome the project most wants to count accurately.</p>
<h2>Contact</h2>
<p>Open an issue at <a href="https://github.com/BrunoOGclaw/canireach/issues">github.com/BrunoOGclaw/canireach/issues</a>. Removal requests are honoured.</p>`;
}

function llmsTxt(s) {
  // llmstxt.org form: "- [name](url): description". A bullet without a real
  // markdown link parses to nothing, which is how this project's companion site
  // once published four machine feeds that no parser could see.
  return `# canireach

> A behavioral access map of the agent web. We measure whether agents can reach the top ${s.domains} domains, what stops them, and which sites publish a detour. Numbers are recomputed from published capture bytes; every capture is downloadable with its SHA-256.

## Data

- [${SITE_ORIGIN}/api/summary.json](${SITE_ORIGIN}/api/summary.json): headline figures, per-caller reachability, affordance adoption, challenge vendors
- [${SITE_ORIGIN}/api/baseline.json](${SITE_ORIGIN}/api/baseline.json): the full derived aggregate for the current capture
- [${SITE_ORIGIN}/method](${SITE_ORIGIN}/method): measurement contract, rails, denominator discipline, comparability rules
- [${SITE_ORIGIN}/bot](${SITE_ORIGIN}/bot): what our probe is and how to block it

## Tools

- [${SITE_ORIGIN}/api/mcp.json](${SITE_ORIGIN}/api/mcp.json): MCP server descriptor — tool names, input schemas, invocation, and the fields an answer will never contain
- [${SITE_ORIGIN}/mcp](${SITE_ORIGIN}/mcp): ${TOOLS.map((t) => t.name).join(' and ')} over stdio; ask what was last measured at a domain, through which door, and whether a detour was published. Read-only, no network, answers from hashed capture bytes

## Source

- [${SITE_ORIGIN}/](${SITE_ORIGIN}/): the human-readable map
- [https://github.com/BrunoOGclaw/canireach](https://github.com/BrunoOGclaw/canireach): instrument source, tests, and issue tracker
- [https://github.com/BrunoOGclaw/canireach/releases](https://github.com/BrunoOGclaw/canireach/releases): immutable captures with manifests and hashes
`;
}

const ROBOTS = `# Agents welcome. This site is the argument for that being normal.
User-agent: *
Allow: /

Sitemap: ${SITE_ORIGIN}/sitemap.xml
`;

const STYLE = `:root{--fg:#12161c;--muted:#5b6673;--line:#dfe4ea;--bg:#fbfcfd;--accent:#1257a8;--warn:#8a5a00}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
header,main,footer{max-width:56rem;margin:0 auto;padding:0 1.25rem}
header{display:flex;flex-wrap:wrap;gap:1rem;align-items:baseline;justify-content:space-between;padding-top:1.5rem;padding-bottom:1.5rem;border-bottom:1px solid var(--line)}
.wordmark{font-weight:700;font-size:1.25rem;letter-spacing:-.02em;text-decoration:none;color:var(--fg)}
.wordmark span{color:var(--accent)}
nav a{margin-left:.9rem;color:var(--muted);text-decoration:none;font-size:.95rem}
nav a:first-child{margin-left:0}
nav a:hover,a:hover{text-decoration:underline}
a{color:var(--accent)}
h1{font-size:2rem;letter-spacing:-.02em;margin:2rem 0 .5rem}
h2{font-size:1.15rem;margin:2.25rem 0 .5rem}
.lede{font-size:1.1rem;color:#333b45}
.card{border:1px solid var(--line);border-radius:10px;padding:1rem 1.25rem;background:#fff;margin:1.5rem 0}
.card.warn{border-color:#e8d9b0;background:#fffdf6}
.card.warn h2{color:var(--warn);margin-top:.25rem}
table{border-collapse:collapse;width:100%;font-size:.95rem;margin:.5rem 0}
th,td{text-align:left;padding:.5rem .6rem;border-bottom:1px solid var(--line);vertical-align:top}
th.n,td.n{text-align:right;font-variant-numeric:tabular-nums}
code{font:.9em ui-monospace,SFMono-Regular,Menlo,monospace;background:#eef1f5;padding:.1em .35em;border-radius:4px}
pre{background:#eef1f5;padding:.9rem;border-radius:8px;overflow-x:auto}
pre code{background:none;padding:0}
.hash{word-break:break-all}
.muted{color:var(--muted);font-size:.9rem}
dl.prov{display:grid;grid-template-columns:9rem 1fr;gap:.35rem 1rem;margin:.5rem 0}
dl.prov dt{color:var(--muted)}
dl.prov dd{margin:0}
footer{border-top:1px solid var(--line);margin-top:3rem;padding-top:1.25rem;padding-bottom:3rem;color:var(--muted);font-size:.9rem}
@media (max-width:34rem){dl.prov{grid-template-columns:1fr}table{font-size:.85rem}}
`;

const HEADERS = `/api/*
  Content-Type: application/json; charset=utf-8
  Access-Control-Allow-Origin: *
  Cache-Control: public, max-age=300

/llms.txt
  Content-Type: text/plain; charset=utf-8

/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
`;

/**
 * Flat `.html` files, not directories, so the host serves /method and /bot with
 * 200 rather than a 308 to a trailing slash. Our probe advertises /bot to every
 * domain it touches; answering that URL with a redirect is the exact
 * agent-hostile sloppiness this project measures in other people.
 */
const PAGES = [
  { path: 'index.html', url: '/', title: 'Can I Reach? — a behavioral access map of the agent web' },
  { path: 'method.html', url: '/method', title: 'Method — Can I Reach?' },
  { path: 'mcp.html', url: '/mcp', title: 'The MCP tool — Can I Reach?' },
  { path: 'bot.html', url: '/bot', title: 'About our probe — Can I Reach?' },
];

export function buildSite({ capture, manifest, out }) {
  const { rows, manifest: m, sha256 } = loadVerifiedCapture(capture, manifest);
  const agg = aggregate(rows);
  const summary = summarise(agg, m, sha256);

  // Coverage is computed by the SAME function the MCP tool serves, over the same
  // rows, so the page cannot claim a split the tool would not report. `as_of` is
  // deliberately dropped: it carries an age against a clock, and this is a file.
  const status = datasetStatus(buildIndex({ manifest: m, rows, dialectClasses: DIALECT_TO_CLASS }), {
    now: m.observed_through ?? m.observed_from ?? new Date(0).toISOString(),
  });
  const coverage = {
    domains_indexed: status.domains_indexed,
    domains_with_any_behavioural_evidence: status.domains_with_any_behavioural_evidence,
    doors_by_evidence: status.doors_by_evidence,
    note: status.note,
  };

  const files = new Map();
  files.set(
    'index.html',
    page(PAGES[0].title, 'Behavioral access measurements for the agent web.', indexBody(summary), `${SITE_ORIGIN}/`),
  );
  files.set(
    'method.html',
    page(PAGES[1].title, 'How Can I Reach measures access, and what it refuses to do.', methodBody(summary), `${SITE_ORIGIN}/method`),
  );
  files.set(
    'mcp.html',
    page(
      PAGES[2].title,
      'The read-only MCP tool an agent calls to ask what was last measured at a domain.',
      mcpBody(summary, coverage),
      `${SITE_ORIGIN}/mcp`,
    ),
  );
  files.set(
    'bot.html',
    page(PAGES[3].title, 'What the CanIReachBot probe is and how to block it.', botBody(), `${SITE_ORIGIN}/bot`),
  );
  files.set(
    '404.html',
    page('Not found — Can I Reach?', 'Not found.', '<h1>Not found</h1><p>Try the <a href="/">map</a> or <a href="/llms.txt">llms.txt</a>.</p>', `${SITE_ORIGIN}/404`),
  );
  files.set('style.css', STYLE);
  files.set('robots.txt', ROBOTS);
  files.set('llms.txt', llmsTxt(summary));
  files.set('_headers', HEADERS);
  const json = new Map([
    ['api/summary.json', summary],
    ['api/baseline.json', { capture_id: m.capture_id, dataset_sha256: sha256, manifest: m, aggregate: agg }],
    ['api/mcp.json', mcpDescriptor(summary, coverage)],
  ]);
  for (const [rel, value] of json) {
    assertNoVolatileClaim(value, rel);
    files.set(rel, JSON.stringify(value, null, 2) + '\n');
  }
  files.set(
    'sitemap.xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${PAGES.map((p) => `  <url><loc>${SITE_ORIGIN}${p.url}</loc></url>`).join('\n')}\n</urlset>\n`,
  );

  if (out) {
    rmSync(out, { recursive: true, force: true });
    for (const [rel, body] of files) {
      const abs = join(out, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
  }
  return { files, summary, aggregate: agg, contact: PROBE_CONTACT };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : dflt;
  };
  try {
    const out = opt('out', 'site');
    const { files, summary } = buildSite({
      capture: opt('capture', DEFAULT_CAPTURE),
      manifest: opt('manifest', DEFAULT_MANIFEST),
      out,
    });
    console.error(`built ${files.size} files -> ${out}/ from capture ${summary.capture_id} (${summary.dataset_sha256.slice(0, 12)}…)`);
  } catch (err) {
    console.error(`FATAL: ${err.message}`);
    process.exit(3);
  }
}
