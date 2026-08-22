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
<nav><a href="/method">Method</a> <a href="/bot">Our bot</a> <a href="/api/summary.json">JSON</a> <a href="https://github.com/BrunoOGclaw/canireach">Source</a></nav>
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
  { path: 'bot.html', url: '/bot', title: 'About our probe — Can I Reach?' },
];

export function buildSite({ capture, manifest, out }) {
  const { rows, manifest: m, sha256 } = loadVerifiedCapture(capture, manifest);
  const agg = aggregate(rows);
  const summary = summarise(agg, m, sha256);

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
    'bot.html',
    page(PAGES[2].title, 'What the CanIReachBot probe is and how to block it.', botBody(), `${SITE_ORIGIN}/bot`),
  );
  files.set(
    '404.html',
    page('Not found — Can I Reach?', 'Not found.', '<h1>Not found</h1><p>Try the <a href="/">map</a> or <a href="/llms.txt">llms.txt</a>.</p>', `${SITE_ORIGIN}/404`),
  );
  files.set('style.css', STYLE);
  files.set('robots.txt', ROBOTS);
  files.set('llms.txt', llmsTxt(summary));
  files.set('_headers', HEADERS);
  files.set('api/summary.json', JSON.stringify(summary, null, 2) + '\n');
  files.set('api/baseline.json', JSON.stringify({ capture_id: m.capture_id, dataset_sha256: sha256, manifest: m, aggregate: agg }, null, 2) + '\n');
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
