// Network-safety and immutable-output tests for the unattended probe.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { probeDomain, probeUrl } from './probe.mjs';

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

const robotsRedirectCalls = [];
const robotsRedirectRows = await probeDomain(1, 'example.com', {
  probeUrlImpl: async (url) => {
    robotsRedirectCalls.push(url);
    return {
      ...result(url, 302),
      redirect: { target_host: '169.254.169.254', target_scheme: 'http', cross_origin: true },
    };
  },
  sleepImpl: noSleep,
});
assert.equal(robotsRedirectCalls.length, 1, 'an unknown redirected robots policy fails closed');
assert.equal(robotsRedirectRows.filter((row) => row.kind === 'request' && row.requested === false).length, 5);

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
