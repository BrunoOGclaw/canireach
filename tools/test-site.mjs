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

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregate } from './aggregate.mjs';
import { SITE_FILES } from './dialects.mjs';
import { DIALECTS, PROBE_CONTACT } from './dialects.mjs';
import { SITE_ORIGIN, buildSite, loadVerifiedCapture } from './build-site.mjs';

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
 */
function makeFixture(dir, { domains = 40, vendorDenials = 30, browserDenials = 4 } = {}) {
  const rows = [];
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
        status: i % 3 === 0 ? 200 : 404,
        present: f.id !== 'robots' ? i % 5 === 0 : undefined,
        soft_404: f.id !== 'robots' ? i % 11 === 0 : undefined,
        outcome: undefined,
        error: null,
      });
    }
    for (const d of DIALECTS) {
      const denied = denyFor(d.id, i);
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
        robots: { allowed: !denied, reason: denied ? 'disallow-rule' : 'allow', known: true },
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
    const bot = file('bot/index.html');
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
