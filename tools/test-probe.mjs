// Network-safety and immutable-output tests for the unattended probe.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { probeDomain, probeUrl, fetchRobots, isPrivateHostLiteral, ROBOTS_MAX_REDIRECTS } from './probe.mjs';

let calls = 0;
const redirectFetch = async () => {
  calls++;
  return new Response('', {
    status: 302,
    headers: { location: 'http://169.254.169.254/latest/meta-data/' },
  });
};

const redirected = await probeUrl('https://example.com/', 'TestAgent/1', { fetchImpl: redirectFetch });
assert.equal(calls, 1, 'a redirect must never trigger a destination request');
assert.equal(redirected.status, 302);
assert.deepEqual(redirected.redirect, {
  target_host: '169.254.169.254',
  target_scheme: 'http',
  cross_origin: true,
});
assert.equal(redirected.body, '', 'redirect bodies are discarded');

calls = 0;
await probeUrl('https://example.com/', 'TestAgent/1', {
  fetchImpl: async () => {
    calls++;
    return new Response('', { status: 301, headers: { location: '/private' } });
  },
});
assert.equal(calls, 1, 'same-origin path redirects are not followed past an unchecked robots path');

// AC of #19: robots.txt started following redirects, and the probe target MUST
// NOT have. A change that relaxed both would be indistinguishable from this one
// in the aggregates, so the probe target's policy is asserted at the one place
// it is actually expressed — the option handed to fetch.
{
  const inits = [];
  await probeUrl('https://example.com/', 'TestAgent/1', {
    fetchImpl: async (_url, init) => {
      inits.push(init);
      return new Response('', { status: 200 });
    },
  });
  assert.equal(inits.length, 1);
  assert.equal(inits[0].redirect, 'manual', 'the probe target must never delegate redirect handling to fetch');
}

const result = (url, status = 200, body = '') => ({
  ok: true,
  status,
  final_url: url,
  redirect: null,
  headers: {},
  body,
  bytes_read: Buffer.byteLength(body),
  elapsed_ms: 1,
});
const noSleep = async () => {};

const deniedCalls = [];
const deniedRows = await probeDomain(1, 'example.com', {
  probeUrlImpl: async (url) => {
    deniedCalls.push(url);
    return result(url, 200, 'User-agent: *\nDisallow: /\n');
  },
  sleepImpl: noSleep,
});
assert.equal(deniedCalls.length, 1, 'a root robots denial permits no later request');
assert.equal(deniedRows.length, 10);
assert.equal(deniedRows.filter((row) => row.kind === 'request' && row.requested === false).length, 5);

// --- robots.txt redirects (RFC 9309 §2.3.1.2) -------------------------------
//
// Measured on the 2026-08-22T162332Z capture: 452 of the top 1,000 domains
// redirect robots.txt and 374 of those go to their own `www.` host. Refusing to
// follow made their policy "unknown", which fails closed, which produced five
// not-attempted doors per domain — an instrument-manufactured silence that a
// reader would naturally count as the web refusing us.

const redirect = (url, status, location) => ({ ...result(url, status), headers: { location } });

/** robots.txt at example.com redirected `hops` times, then answered. */
function redirectChain(hops, terminalStatus = 200, body = '') {
  const seen = [];
  const impl = async (url) => {
    seen.push(url);
    if (!url.endsWith('/robots.txt')) return result(url);
    const at = url === 'https://example.com/robots.txt' ? 0 : Number(/h(\d+)\./.exec(url)[1]);
    if (at < hops) return redirect(url, 301, `https://h${at + 1}.example.com/robots.txt`);
    return result(url, terminalStatus, body);
  };
  return { impl, seen };
}

// A cross-authority redirect is followed, and the policy it yields governs the
// INITIAL authority. This is the clause that makes following safe.
{
  const seen = [];
  const rows = await probeDomain(1, 'example.com', {
    probeUrlImpl: async (url) => {
      seen.push(url);
      if (url === 'https://example.com/robots.txt') return redirect(url, 301, 'https://www.example.com/robots.txt');
      if (url === 'https://www.example.com/robots.txt') return result(url, 200, 'User-agent: *\nDisallow: /\n');
      return result(url);
    },
    sleepImpl: noSleep,
  });
  assert.deepEqual(
    seen,
    ['https://example.com/robots.txt', 'https://www.example.com/robots.txt'],
    'robots.txt must be followed across authorities, and a deny-all fetched from www still denies',
  );
  const robotsRow = rows.find((r) => r.kind === 'file' && r.file === 'robots');
  assert.equal(robotsRow.status, 200, 'the robots row reports the status the policy was actually read from');
  assert.equal(robotsRow.redirected, true);
  assert.equal(robotsRow.redirect_hops, 1);
  assert.deepEqual(robotsRow.redirect_chain, [
    { status: 301, target_host: 'www.example.com', target_scheme: 'https', cross_authority: true },
  ]);
  assert.equal(robotsRow.final_host, 'www.example.com', 'the chain must name the authority that answered');
  assert.equal(robotsRow.redirect_refusal, null);
  assert.equal(
    rows.filter((r) => r.kind === 'request' && r.requested === false).length,
    5,
    'a policy fetched from www governs requests to the initial authority',
  );
}

// Following the policy document is not following the site: every measured
// request still goes to the domain on the input list.
{
  const seen = [];
  await probeDomain(1, 'example.com', {
    probeUrlImpl: async (url) => {
      seen.push(url);
      if (url === 'https://example.com/robots.txt') return redirect(url, 302, 'https://www.example.com/robots.txt');
      if (url === 'https://www.example.com/robots.txt') return result(url, 200, '');
      return result(url);
    },
    sleepImpl: noSleep,
  });
  const afterPolicy = seen.slice(2);
  assert.equal(afterPolicy.length, 9, 'a permissive redirected policy permits all five dialects and four files');
  assert.ok(
    afterPolicy.every((url) => url.startsWith('https://example.com/')),
    'rules apply in the context of the initial authority: no measured request may drift onto the redirect target',
  );
}

// The budget is the RFC's number, not ours, so it is asserted as a LITERAL
// against the spec. Everything below derives its expectations from the constant
// — which is right for exercising the mechanism and useless for pinning the
// value: raise the constant and those tests raise with it. Caught by
// tools/mutate-probe.mjs, which is the only reason this line exists.
//
//   RFC 9309 §2.3.1.2: "The crawlers SHOULD follow at least five consecutive
//   redirects, even across authorities."
assert.equal(ROBOTS_MAX_REDIRECTS, 5, 'the follow budget is fixed by RFC 9309 §2.3.1.2');

// A chain spelled out at full length, so the budget is exercised against the
// spec's number rather than against whatever the constant currently says.
{
  const literal = redirectChain(6);
  const out = await fetchRobots('example.com', 'TestAgent/1', { probeUrlImpl: literal.impl, sleepImpl: noSleep });
  assert.equal(out.refusal, 'redirect-exhausted', 'six consecutive redirects is more than five: policy is unavailable');
  assert.equal(literal.seen.length, 6, 'exactly five redirects are followed, and the sixth is only observed');
}

// The budget, at both sides of the boundary.
{
  const atLimit = redirectChain(ROBOTS_MAX_REDIRECTS, 200, 'User-agent: *\nDisallow: /x\n');
  const followed = await fetchRobots('example.com', 'TestAgent/1', { probeUrlImpl: atLimit.impl, sleepImpl: noSleep });
  assert.equal(atLimit.seen.length, ROBOTS_MAX_REDIRECTS + 1, 'five consecutive redirects must be followed');
  assert.equal(followed.refusal, null);
  assert.equal(followed.res.status, 200);
  assert.equal(followed.hops, ROBOTS_MAX_REDIRECTS);
  assert.equal(followed.final_url, `https://h${ROBOTS_MAX_REDIRECTS}.example.com/robots.txt`);

  const overLimit = redirectChain(ROBOTS_MAX_REDIRECTS + 1);
  const exhausted = await fetchRobots('example.com', 'TestAgent/1', { probeUrlImpl: overLimit.impl, sleepImpl: noSleep });
  assert.equal(
    overLimit.seen.length,
    ROBOTS_MAX_REDIRECTS + 1,
    'a sixth consecutive redirect is observed but never followed',
  );
  assert.equal(exhausted.refusal, 'redirect-exhausted');
  assert.equal(exhausted.hops, ROBOTS_MAX_REDIRECTS + 1, 'the hop that broke the budget is still recorded');
}

// Every way of failing to reach a policy document still fails CLOSED, and every
// reason still carries `policy-unknown` — the substring tools/aggregate.mjs uses
// to keep "the site said no" apart from "we could not read the site's answer".
for (const [label, impl, expected] of [
  [
    'a redirect to cloud metadata',
    async (url) => (url.endsWith('/robots.txt') ? redirect(url, 302, 'http://169.254.169.254/latest/meta-data/') : result(url)),
    'redirect-refused-private-target',
  ],
  [
    'a redirect with no Location',
    async (url) => (url.endsWith('/robots.txt') ? result(url, 301) : result(url)),
    'redirect-no-location',
  ],
  [
    'a redirect to a non-HTTP scheme',
    async (url) => (url.endsWith('/robots.txt') ? redirect(url, 301, 'ftp://files.example.com/robots.txt') : result(url)),
    'redirect-unsupported-scheme',
  ],
  [
    'a redirect loop',
    async (url) =>
      url === 'https://example.com/robots.txt'
        ? redirect(url, 301, 'https://www.example.com/robots.txt')
        : url === 'https://www.example.com/robots.txt'
          ? redirect(url, 301, 'https://example.com/robots.txt')
          : result(url),
    'redirect-loop',
  ],
]) {
  const seen = [];
  const rows = await probeDomain(1, 'example.com', {
    probeUrlImpl: async (url) => {
      seen.push(url);
      return impl(url);
    },
    sleepImpl: noSleep,
  });
  const refused = rows.filter((r) => r.kind === 'request' && r.requested === false);
  assert.equal(refused.length, 5, `${label} must fail closed`);
  assert.equal(rows.find((r) => r.file === 'robots').redirect_refusal, expected, label);
  for (const row of refused) {
    assert.ok(
      row.robots.reason.includes('policy-unknown'),
      `${label} must read as unknown policy, not as a denial by the host`,
    );
    assert.equal(row.robots.known, false);
  }
  assert.ok(seen.every((url) => url.endsWith('/robots.txt')), `${label} must send no measured request`);
}

// The 404/410 exception reads the TERMINAL response: a robots.txt that redirects
// to an explicit absence is absent policy, not unknown policy.
{
  const absent = redirectChain(2, 404);
  const rows = await probeDomain(1, 'example.com', { probeUrlImpl: absent.impl, sleepImpl: noSleep });
  assert.equal(rows.filter((r) => r.kind === 'request' && r.requested === true).length, 5);
  assert.equal(rows.find((r) => r.file === 'robots').status, 404);
}

// The private-literal guard, at its edges. A hostname that RESOLVES into private
// space is deliberately out of scope and must not be claimed.
for (const host of [
  '127.0.0.1', '169.254.169.254', '10.0.0.1', '192.168.1.1', '172.16.0.1', '172.31.255.255',
  '100.64.0.1', '0.0.0.0', 'localhost', 'foo.localhost', '[::1]', '[fe80::1]', '[fd00::1]', '[fc00::1]', '[::]',
  // The same private addresses wearing IPv4-mapped spelling. WHATWG URL
  // normalizes `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, so a check that
  // handled only the v6 prefixes above left all of private v4 reachable
  // through one extra colon.
  '[::ffff:7f00:1]', '[::ffff:127.0.0.1]', '[::ffff:a9fe:a9fe]', '[::ffff:169.254.169.254]', '[::ffff:c0a8:1]',
]) {
  assert.equal(isPrivateHostLiteral(host), true, `${host} must be refused as a redirect target`);
}
for (const host of [
  'www.example.com', '8.8.8.8', '172.32.0.1', '172.15.0.1', '100.63.0.1', '100.128.0.1',
  '[2606:4700::1111]', '[::ffff:8.8.8.8]', '[::ffff:808:808]',
]) {
  assert.equal(isPrivateHostLiteral(host), false, `${host} is public and must be followable`);
}

// The mapped-address fold must be exercised through a real redirect too, not
// only as a unit call: the URL parser is what produces the hex spelling.
{
  const rows = await probeDomain(1, 'example.com', {
    probeUrlImpl: async (url) =>
      url.endsWith('/robots.txt') ? redirect(url, 302, 'http://[::ffff:169.254.169.254]/latest/meta-data/') : result(url),
    sleepImpl: noSleep,
  });
  assert.equal(
    rows.find((r) => r.file === 'robots').redirect_refusal,
    'redirect-refused-private-target',
    'an IPv4-mapped metadata address must be refused exactly like its dotted spelling',
  );
}

const missingCalls = [];
await probeDomain(1, 'example.com', {
  probeUrlImpl: async (url) => {
    missingCalls.push(url);
    return missingCalls.length === 1 ? result(url, 404) : result(url);
  },
  sleepImpl: noSleep,
});
assert.equal(missingCalls.length, 10, 'an explicit 404 means no robots policy and permits the measured requests');

const pathCalls = [];
await probeDomain(1, 'example.com', {
  probeUrlImpl: async (url) => {
    pathCalls.push(url);
    return pathCalls.length === 1 ? result(url, 200, 'User-agent: *\nDisallow: /llms.txt\n') : result(url);
  },
  sleepImpl: noSleep,
});
assert.equal(pathCalls.length, 9, 'an affordance-path denial removes exactly that request');
assert.equal(pathCalls.some((url) => url.endsWith('/llms.txt')), false);

const dir = mkdtempSync(join(tmpdir(), 'cir-output-'));
const run = 'fixed-run';
const out = join(dir, `${run}.jsonl`);
const list = join(dir, 'domains.csv');
writeFileSync(list, '1,example.invalid\n');
writeFileSync(out, 'immutable\n');

const existing = spawnSync(
  process.execPath,
  ['tools/probe.mjs', '--run', run, '--out', out, '--list', list, '--limit', '1', '--concurrency', '1'],
  { encoding: 'utf8' },
);
assert.notEqual(existing.status, 0, 'an existing completed capture must be refused');
assert.match(existing.stderr, /refusing to replace completed capture/);
assert.equal(readFileSync(out, 'utf8'), 'immutable\n', 'refusal must preserve existing bytes');

const mismatch = spawnSync(
  process.execPath,
  ['tools/probe.mjs', '--run', run, '--out', join(dir, 'different.jsonl'), '--list', list],
  { encoding: 'utf8' },
);
assert.notEqual(mismatch.status, 0, 'run identity and final filename may not diverge');
assert.match(mismatch.stderr, /output filename must match immutable run identity/);

console.log('probe safety: robots gating, redirect refusal, and immutable output identity passed');
