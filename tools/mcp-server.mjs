// The agent-facing MCP server: the traveler's seat, in an agent's own loop.
//
// Speaks JSON-RPC 2.0 over stdio, newline-delimited, with no dependencies —
// this repo has no package.json and gains none for a protocol that is a few
// message shapes. `tools/test-mcp.mjs` drives a real child process over a real
// pipe, because a handler tested by direct function call proves the handler and
// says nothing about the transport.
//
// RAILS, and each is enforced by a test rather than promised here:
//   * READ-ONLY, and no network. There is no `fetch` in this file or in
//     lookup.mjs, and neither imports probe.mjs. A reachability tool that probes
//     on demand is an on-request scanner aimed at whatever third party the
//     caller names, which the charter forbids outright.
//   * Everything answered comes from a capture whose bytes hashed to the
//     SHA-256 its manifest published, plus crowd claims already promoted by
//     tools/reports.mjs. No hand-maintained table is consulted.
//   * STDOUT CARRIES PROTOCOL AND NOTHING ELSE. Every diagnostic goes to stderr.
//     One stray console.log corrupts the stream for every client, and it is the
//     easiest possible defect to introduce and the hardest to see.
//
// Usage:
//   node tools/mcp-server.mjs --manifest FILE [--capture FILE] [--ledger FILE]
//
// The ledger is optional: a JSONL file of accepted crowd reports, one
// `{report, received_at}` per line. With no ledger the crowd block is present
// and empty, which is the honest state today — there is no public ingest
// endpoint yet, so there are no accepted reports yet.

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { loadVerifiedCapture, resolveCapturePath } from './capture.mjs';
import { DIALECT_TO_CLASS, probeEvidenceFromCapture, resolve } from './reports.mjs';
import { buildIndex, datasetStatus, lookup } from './lookup.mjs';

export const SERVER_NAME = 'canireach';
export const SERVER_VERSION = '0.1.0';
export const PROTOCOL_VERSION = '2025-06-18';

export const TOOLS = [
  {
    name: 'reachability_lookup',
    description:
      'What canireach last measured at a domain: which identities were let through, which were refused, ' +
      'which were never asked, and the detour where one is published (llms.txt, agents.md, a Web Bot Auth ' +
      'directory, a 402 toll). Answers describe a past measurement and carry its capture id, observation ' +
      'slot, vantage and age. A host that has never been probed answers "unknown" rather than an inference.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description:
            'Hostname to look up, e.g. "example.com". A URL is accepted and its host used. No parent-domain ' +
            'fallback: api.example.com is not example.com.',
        },
      },
      required: ['domain'],
      additionalProperties: false,
    },
  },
  {
    name: 'dataset_status',
    description:
      'Which capture is loaded, how old it is, and how much of it is behavioural evidence rather than doors ' +
      'this instrument chose not to knock on. Read this before trusting any lookup: most of the dataset is ' +
      'usually the latter.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

// --- wiring -----------------------------------------------------------------

export function loadIndex({ manifestPath, capturePath = null, ledgerPath = null }) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const resolved = resolveCapturePath(manifestPath, manifest, capturePath);
  const { rows } = loadVerifiedCapture(resolved, manifestPath);

  let resolution = null;
  if (ledgerPath) {
    const ledger = readFileSync(ledgerPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    resolution = resolve(ledger, {
      probeEvidence: probeEvidenceFromCapture(manifest, rows),
      now: new Date().toISOString(),
    });
  }

  return buildIndex({ manifest, rows, resolution, dialectClasses: DIALECT_TO_CLASS });
}

// --- JSON-RPC ---------------------------------------------------------------

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/**
 * A tool result. MCP reports TOOL failures inside a successful result with
 * `isError: true`, reserving JSON-RPC errors for protocol faults — so a bad
 * domain string comes back as a readable message the calling model can act on
 * rather than as a transport error it cannot see.
 */
const toolResult = (payload, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  isError,
});

export function callTool(index, name, args, { now }) {
  if (name === 'dataset_status') return toolResult(datasetStatus(index, { now }));
  if (name === 'reachability_lookup') {
    const domain = args?.domain;
    if (typeof domain !== 'string' || !domain.trim()) {
      return toolResult({ error: 'reachability_lookup requires a `domain` string' }, true);
    }
    try {
      return toolResult(lookup(index, domain, { now }));
    } catch (err) {
      return toolResult({ error: String(err.message ?? err) }, true);
    }
  }
  return toolResult({ error: `unknown tool '${name}'` }, true);
}

/**
 * One message in, at most one message out.
 *
 * Returns null for anything that must not be answered: a notification (no `id`)
 * per JSON-RPC, and any response the client sends us. Answering a notification
 * is a protocol violation that some clients tolerate and others hang on.
 */
export function handle(message, index, { now }) {
  if (!message || message.jsonrpc !== '2.0') return fail(null, INVALID_REQUEST, 'expected a JSON-RPC 2.0 message');
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;
  if (!method) return null;

  switch (method) {
    case 'initialize':
      return isNotification
        ? null
        : ok(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return isNotification ? null : ok(id, {});
    case 'tools/list':
      return isNotification ? null : ok(id, { tools: TOOLS });
    case 'tools/call': {
      if (isNotification) return null;
      const name = params?.name;
      if (typeof name !== 'string') return fail(id, INVALID_PARAMS, 'tools/call requires params.name');
      return ok(id, callTool(index, name, params?.arguments ?? {}, { now }));
    }
    default:
      return isNotification ? null : fail(id, METHOD_NOT_FOUND, `unknown method '${method}'`);
  }
}

// --- stdio ------------------------------------------------------------------

export function serve({ index, input = process.stdin, output = process.stdout, clock = () => new Date().toISOString() }) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  const write = (msg) => output.write(JSON.stringify(msg) + '\n');

  rl.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write(fail(null, PARSE_ERROR, 'could not parse JSON'));
      return;
    }
    let response;
    try {
      response = handle(message, index, { now: clock() });
    } catch (err) {
      // A thrown handler must not take the server down: the client would see a
      // closed pipe and no reason for it.
      response = fail(message?.id ?? null, INVALID_REQUEST, String(err.message ?? err));
    }
    if (response) write(response);
  });

  return rl;
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const manifestPath = argValue(args, '--manifest');
  if (!manifestPath) {
    console.error('usage: node tools/mcp-server.mjs --manifest FILE [--capture FILE] [--ledger FILE]');
    process.exit(2);
  }
  let index;
  try {
    index = loadIndex({
      manifestPath,
      capturePath: argValue(args, '--capture'),
      ledgerPath: argValue(args, '--ledger'),
    });
  } catch (err) {
    console.error(`refusing to serve: ${err.message}`);
    process.exit(3);
  }
  // stderr, always. stdout is the protocol.
  console.error(
    `${SERVER_NAME} ${SERVER_VERSION} serving ${index.domains} domains from ${index.manifest.capture_id}`,
  );
  serve({ index });
}
