// Build a capture's manifest from the capture itself.
//
// Every number here is derived at build time from the bytes being published.
// None of it is typed by hand — a hand-maintained summary of a growing dataset
// drifts away from the data it summarises, and the correction history of the
// first baseline release is what that costs.
//
// Usage: node tools/manifest.mjs <capture.jsonl> [--list FILE] [--out FILE]

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { validateFile } from './validate.mjs';
import { DIALECTS } from './dialects.mjs';

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function git(...args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

export function buildManifest(capturePath, listPath) {
  const text = readFileSync(capturePath, 'utf8');
  const rows = text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  const expectedDomains = readFileSync(listPath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.split(',')[1]).length;

  const { ok, checks, stats } = validateFile(capturePath, { expectedDomains });
  const timestamps = rows.map((r) => r.ts).filter(Boolean).sort();

  return {
    schema_version: 2,
    capture_id: capturePath.split('/').pop().replace(/\.jsonl$/, ''),
    capture_class: 'pre-2026-09-15-baseline',
    vantage: [...new Set(rows.map((r) => r.vantage ?? 'unspecified'))].join(','),
    observed_from: timestamps[0] ?? null,
    observed_through: timestamps[timestamps.length - 1] ?? null,
    run_value: [...new Set(rows.map((r) => r.run))].join(','),
    generator_commit: git('rev-parse', 'HEAD'),
    generator_tree_clean: git('status', '--porcelain') === '',
    input: {
      name: listPath,
      sha256: sha256(listPath),
      domains: expectedDomains,
    },
    dataset: {
      name: capturePath.split('/').pop(),
      sha256: sha256(capturePath),
      bytes: Buffer.byteLength(text),
      rows: stats.rows,
      domains: stats.domains,
      request_rows: stats.request_rows,
      file_rows: stats.file_rows,
      requests_sent: stats.requests_sent,
    },
    // The gates this capture passed, published WITH the data. A reader should be
    // able to see what was checked, not just that something was.
    gates: { all_passed: ok, checks: checks.map((c) => ({ id: c.id, ok: c.ok, detail: c.detail })) },
    aggregates: {
      outcomes: stats.outcomes,
      by_dialect: stats.by_dialect,
      robots_policy: stats.robots_policy,
      robots_txt: stats.robots_txt,
      affordances: stats.affordances,
      challenges: stats.challenges,
      toll: stats.toll,
      top_servers: stats.top_servers,
    },
    privacy: {
      response_bodies_stored: false,
      cookies_stored: false,
      presented_user_agent_strings_stored: false,
      general_response_header_maps_stored: false,
      selected_response_header_values_stored: ['server', 'x_robots_tag', 'content_type'],
      selected_header_presence_stored: ['cf_ray'],
      selected_header_names_stored: ['toll.headers allowlist'],
    },
    identity_note: `Vendor-token dialects (${DIALECTS.filter((d) => d.kind === 'vendor-token-disclosed')
      .map((d) => d.id)
      .join(', ')}) are disclosed simulations carrying a canireach disclosure in the UA, not authenticated vendor traffic. See METHODOLOGY.md.`,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (n, d) => {
    const i = args.indexOf(n);
    return i >= 0 && args[i + 1] ? args[i + 1] : d;
  };
  const file = args.find((a) => !a.startsWith('--') && a !== opt('--list', null) && a !== opt('--out', null));
  if (!file) {
    console.error('usage: node tools/manifest.mjs <capture.jsonl> [--list FILE] [--out FILE]');
    process.exit(2);
  }
  const manifest = buildManifest(file, opt('--list', 'data/domains/tranco-74V8X-1000.csv'));
  const json = JSON.stringify(manifest, null, 2);
  const out = opt('--out', null);
  if (out) {
    writeFileSync(out, json + '\n');
    console.error(`manifest -> ${out}`);
  } else {
    console.log(json);
  }
  // A manifest for a capture that failed its gates must not be mistaken for a
  // publishable one, even though it is still useful for diagnosis.
  if (!manifest.gates.all_passed) process.exit(1);
}
