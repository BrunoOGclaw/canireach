// Tests for the MCP server, driven as a real child process over a real pipe.
//
// WHY A CHILD PROCESS AND NOT A DIRECT CALL. `handle()` is a pure function and
// testing it proves the message shapes; it proves nothing about the transport,
// and the transport is where an MCP server actually fails: a stray console.log
// corrupts stdout for every client, a notification answered with a response
// hangs some clients, and a handler that throws closes the pipe with no reason
// on it. This project has already ruled that reading a script is not running it
// (tools/test-preflight.mjs, tools/test-series-step.mjs); the same argument
// applies one layer up, to a protocol.
//
// Run: node tools/test-mcp.mjs

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, SERVER_NAME, TOOLS, callTool, handle } from './mcp-server.mjs';
import { DIALECT_TO_CLASS } from './reports.mjs';
import { buildIndex } from './lookup.mjs';

let pass = 0;
const failures = [];

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else failures.push(`${label}\n     expected ${e}\n     actual   ${a}`);
}
function ok(cond, label) {
  if (cond) pass++;
  else failures.push(label);
}

const HERE = new URL('.', import.meta.url).pathname;
const SERVER = join(HERE, 'mcp-server.mjs');

// --- a real capture on disk, hashed the way the loader will hash it ---------

const dir = mkdtempSync(join(tmpdir(), 'cir-mcp-'));
const OBSERVED = '2026-08-22T09:19:00.000Z';
const rows = [
  {
    schema_version: 2,
    ts: OBSERVED,
    domain: 'open.example',
    kind: 'request',
    dialect: 'canireach',
    robots: { allowed: true, reason: 'no-matching-rule', explicit: false, known: true },
    requested: true,
    outcome: 'reachable',
    status: 200,
  },
  {
    schema_version: 2,
    ts: OBSERVED,
    domain: 'shut.example',
    kind: 'request',
    dialect: 'canireach',
    robots: { allowed: false, reason: 'robots-policy-unknown-http-503', explicit: false, known: false },
    requested: false,
    outcome: 'denied_by_robots',
  },
  { schema_version: 2, ts: OBSERVED, domain: 'open.example', kind: 'file', file: 'llms_txt', status: 200, present: true },
];
const jsonl = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const capturePath = join(dir, 'capture.jsonl');
writeFileSync(capturePath, jsonl);

const manifest = {
  schema_version: 3,
  capture_id: 'test-capture',
  observation_window: { slot: '04:17[America/Chicago]', drift_minutes: 2 },
  observed_from: OBSERVED,
  observed_through: OBSERVED,
  vantage: { class: 'github-hosted-dynamic-egress' },
  instrument_policy: { profile_version: 1 },
  dataset: {
    name: 'capture.jsonl',
    sha256: createHash('sha256').update(jsonl).digest('hex'),
    rows: rows.length,
  },
};
const manifestPath = join(dir, 'capture.manifest.json');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

// --- drive the server over stdio --------------------------------------------

/**
 * Send a list of messages, collect every line stdout produced, and keep stderr
 * apart. Both streams are returned because the separation IS one of the things
 * under test.
 */
function converse(messages, args = ['--manifest', manifestPath]) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
    for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
    child.stdin.end();
  });
}

const parseLines = (out) =>
  out
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

// --- 1. the handshake, over the wire ----------------------------------------

const session = await converse([
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'reachability_lookup', arguments: { domain: 'open.example' } } },
  { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'dataset_status', arguments: {} } },
]);

eq(session.code, 0, 'the server exits cleanly when its input closes');

let messages;
try {
  messages = parseLines(session.out);
  pass++;
} catch (e) {
  failures.push(`stdout is not newline-delimited JSON: ${e.message}\n     ${session.out.slice(0, 200)}`);
  messages = [];
}

// The notification must NOT be answered. Four requests in, four responses out.
eq(messages.length, 4, 'a notification draws no response — four requests, four responses');
eq(
  messages.map((m) => m.id),
  [1, 2, 3, 4],
  'responses come back in order, one per request id',
);
eq(messages[0].result.serverInfo.name, SERVER_NAME, 'initialize names the server');
eq(messages[0].result.protocolVersion, PROTOCOL_VERSION, 'and its protocol version');
ok(messages[0].result.capabilities.tools, 'and declares a tools capability');

// --- 2. stdout carries protocol and NOTHING else ----------------------------
// The easiest defect in this file to introduce, and the hardest to see: one
// console.log and every client's stream is corrupt.

ok(
  session.out.split('\n').filter((l) => l.trim()).every((l) => l.trim().startsWith('{')),
  'every stdout line is a JSON object',
);
ok(session.err.includes('serving'), 'the startup banner went to stderr');
ok(!session.out.includes('serving'), 'and not to stdout');

// --- 3. tools/list is the advertised surface --------------------------------

eq(
  messages[1].result.tools.map((t) => t.name).sort(),
  ['dataset_status', 'reachability_lookup'],
  'both tools are advertised',
);
eq(messages[1].result.tools.length, TOOLS.length, 'the wire list is the exported list');
ok(
  messages[1].result.tools.every((t) => t.inputSchema?.type === 'object' && t.description),
  'each tool carries a description and an object schema',
);
ok(
  messages[1].result.tools.find((t) => t.name === 'reachability_lookup').inputSchema.required.includes('domain'),
  'the lookup requires a domain',
);
ok(
  messages[1].result.tools.find((t) => t.name === 'reachability_lookup').description.includes('past measurement'),
  'the tool description tells the calling model the answer is about the past',
);

// --- 4. a real answer, through the transport --------------------------------

const answer = JSON.parse(messages[2].result.content[0].text);
eq(messages[2].result.isError ?? false, false, 'a good lookup is not an error');
eq(answer.domain, 'open.example', 'the answer is for the domain asked about');
eq(answer.answer, 'measured', 'and it is a measurement');
eq(answer.doors[0].last_outcome, 'reachable', 'with the outcome we recorded');
eq(answer.as_of.capture_id, 'test-capture', 'carrying its provenance across the wire');
ok(typeof answer.as_of.age_minutes === 'number', 'and its age, computed against the wall clock at the edge');
ok(answer.as_of.freshness === 'stale', 'a fixture captured in the past is served as stale, not as current');

const statusText = JSON.parse(messages[3].result.content[0].text);
eq(statusText.domains_indexed, 2, 'dataset_status counts what was indexed');
eq(statusText.doors_by_evidence['not-attempted'], 1, 'and separates doors we never knocked on');

// --- 5. failures are readable, not fatal ------------------------------------
// A bad argument comes back as a tool error the calling model can read and act
// on. A JSON-RPC error would be invisible to it.

const bad = await converse([
  { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'reachability_lookup', arguments: { domain: 'not a host' } } },
  { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'reachability_lookup', arguments: {} } },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } },
  { jsonrpc: '2.0', id: 4, method: 'no/such/method' },
  { jsonrpc: '2.0', id: 5, method: 'ping' },
]);
const badMessages = parseLines(bad.out);
eq(badMessages.length, 5, 'every request is answered, none crashes the server');
eq(badMessages[0].result.isError, true, 'an unparseable domain is a TOOL error');
ok(JSON.parse(badMessages[0].result.content[0].text).error.includes('not a host'), 'and says what was wrong');
eq(badMessages[1].result.isError, true, 'a missing domain is a tool error');
eq(badMessages[2].result.isError, true, 'an unknown tool is a tool error');
eq(badMessages[3].error.code, -32601, 'an unknown METHOD is a protocol error');
eq(badMessages[4].result, {}, 'ping is answered');
eq(bad.code, 0, 'and the server still exits cleanly');

// Malformed input on the wire.
const garbage = await new Promise((resolve) => {
  const child = spawn(process.execPath, [SERVER, '--manifest', manifestPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.on('close', () => resolve(out));
  child.stdin.write('this is not json\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }) + '\n');
  child.stdin.end();
});
const garbageMessages = parseLines(garbage);
eq(garbageMessages[0].error.code, -32700, 'unparseable input is a parse error');
eq(garbageMessages[1].id, 9, 'and the server keeps serving after it');

// --- 6. the server refuses to serve unverified bytes ------------------------
// The whole answer surface rests on the capture being the published capture.

const tamperedCapture = join(dir, 'tampered.jsonl');
writeFileSync(tamperedCapture, jsonl.replace('"reachable"', '"blocked"'));
const tamperedManifest = join(dir, 'tampered.manifest.json');
writeFileSync(tamperedManifest, JSON.stringify({ ...manifest, dataset: { ...manifest.dataset, name: 'tampered.jsonl' } }));
const refused = await converse([{ jsonrpc: '2.0', id: 1, method: 'ping' }], ['--manifest', tamperedManifest]);
eq(refused.code, 3, 'bytes that do not hash to the published manifest are refused at startup');
ok(refused.err.includes('refusing to serve'), 'and it says so');
eq(refused.out, '', 'having answered nothing');

const noArgs = await converse([], []);
eq(noArgs.code, 2, 'no --manifest is a usage error');

// --- 7. handler-level cases the wire cannot easily reach --------------------

const index = buildIndex({ manifest, rows, dialectClasses: DIALECT_TO_CLASS });
const NOW = '2026-08-22T10:19:00.000Z';

eq(handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, index, { now: NOW }), null, 'notifications are never answered');
eq(handle({ jsonrpc: '2.0', method: 'initialize' }, index, { now: NOW }), null, 'even initialize, if sent as a notification');
eq(handle({ jsonrpc: '2.0', method: 'tools/list' }, index, { now: NOW }), null, 'and tools/list');
ok(handle({ jsonrpc: '1.0', id: 1, method: 'ping' }, index, { now: NOW }).error, 'a non-2.0 message is refused');
eq(
  handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} }, index, { now: NOW }).error.code,
  -32602,
  'tools/call with no name is an invalid-params error',
);
// id 0 is falsy and is a legal JSON-RPC id. A truthiness check here would treat
// it as a notification and silently never answer.
ok(handle({ jsonrpc: '2.0', id: 0, method: 'ping' }, index, { now: NOW })?.id === 0, 'id 0 is a request, not a notification');

const unknownTool = callTool(index, 'reachability_lookup', { domain: 'never-probed.example' }, { now: NOW });
eq(JSON.parse(unknownTool.content[0].text).answer, 'unknown', 'an unprobed host answers unknown through the tool layer');
eq(unknownTool.isError ?? false, false, 'and "unknown" is a legitimate answer, not an error');

rmSync(dir, { recursive: true, force: true });

// --- report ------------------------------------------------------------------

if (failures.length) {
  console.error(`FAIL ${failures.length} of ${pass + failures.length}`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`ok  ${pass} assertions (MCP server, over a real pipe)`);
