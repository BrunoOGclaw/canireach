// Prove the origin serves the bytes this build produced.
//
// "Deployed" and "serving" are different claims. A deploy command that exits 0
// has told you about an upload, not about what a visitor receives — the domain
// can be pinned to an older deployment, a rewrite rule can shadow a path, and a
// URL advertised in llms.txt can 404 while the build that produced it is
// perfectly healthy. So this fetches every built path from the real origin and
// byte-compares.
//
// Usage: node tools/verify-serving.mjs [--origin https://canireach.ai] [--build site]
// Exit codes: 0 serving matches, 2 usage, 4 a path is missing, redirected, or differs.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { SITE_ORIGIN } from './build-site.mjs';

const MISMATCH = 4;

/**
 * Built files whose served form legitimately differs from the file on disk.
 * Named and justified individually: a silent skip list is how a verifier ends
 * up checking three paths and reporting the whole site healthy.
 */
const EXCLUDED = new Map([
  ['_headers', 'a host directive, consumed at deploy time and never served as a document'],
  ['404.html', 'served only as the not-found body, so a direct request answers 404 by design'],
]);

/** Built path -> the URL a visitor actually uses. Flat .html pages serve extensionless. */
export function servedPath(rel) {
  if (rel === 'index.html') return '/';
  if (rel.endsWith('.html')) return `/${rel.slice(0, -'.html'.length)}`;
  return `/${rel}`;
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...walk(abs, base));
    else out.push(relative(base, abs));
  }
  return out.sort();
}

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const origin = (opt('origin', SITE_ORIGIN) || '').replace(/\/+$/, '');
const buildDir = opt('build', 'site');
if (!origin.startsWith('http')) {
  console.error('usage: node tools/verify-serving.mjs [--origin URL] [--build DIR]');
  process.exit(2);
}

const built = walk(buildDir);
const checked = [];
const problems = [];

for (const rel of built) {
  const why = EXCLUDED.get(rel);
  if (why) {
    console.log(`skip ${rel.padEnd(22)} ${why}`);
    continue;
  }
  const url = `${origin}${servedPath(rel)}`;
  const expected = readFileSync(join(buildDir, rel));
  let res;
  try {
    // redirect: 'manual' on purpose. A 308 to a trailing slash still "works" in
    // a browser and still means the URL we advertise is not the URL we serve.
    res = await fetch(url, { redirect: 'manual', headers: { 'user-agent': 'canireach-verify/1' } });
  } catch (err) {
    problems.push(`${url} -> request failed: ${err.message}`);
    continue;
  }
  if (res.status !== 200) {
    problems.push(`${url} -> HTTP ${res.status}${res.headers.get('location') ? ` -> ${res.headers.get('location')}` : ''}`);
    continue;
  }
  const actual = Buffer.from(await res.arrayBuffer());
  const a = createHash('sha256').update(expected).digest('hex');
  const b = createHash('sha256').update(actual).digest('hex');
  if (a !== b) {
    problems.push(`${url} -> serves different bytes (built ${a.slice(0, 12)}…, served ${b.slice(0, 12)}…)`);
    continue;
  }
  checked.push(url);
  console.log(`ok   ${servedPath(rel).padEnd(22)} ${a.slice(0, 12)}…`);
}

// An unknown path must not answer 200. A host that says yes to everything makes
// every check above pass for the wrong reason.
const bogus = `${origin}/canireach-verify-should-not-exist-${Date.now()}`;
try {
  const res = await fetch(bogus, { redirect: 'manual' });
  if (res.status === 200) problems.push(`${bogus} -> HTTP 200; the origin answers 200 to unknown paths`);
  else console.log(`ok   unknown path answers ${res.status}`);
} catch (err) {
  problems.push(`${bogus} -> request failed: ${err.message}`);
}

if (problems.length) {
  console.error(`\n${problems.length} serving problem(s) at ${origin}:`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(MISMATCH);
}
console.log(`\n${checked.length} path(s) byte-match what ${origin} serves`);
