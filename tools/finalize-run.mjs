// Validate a complete capture, then create the immutable release sidecars.
// No file is publishable unless this gate passes.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { aggregateFile } from './aggregate.mjs';
import { INSTRUMENT_POLICY, ROW_SCHEMA_VERSION, observationWindow } from './policy.mjs';

const DIALECTS = ['browser', 'curl', 'canireach', 'gptbot', 'claudebot'];
const FILES = ['robots', 'llms_txt', 'agents_md', 'wellknown_agents', 'web_bot_auth'];
const COMMON_ROW_KEYS = ['schema_version', 'ts', 'run', 'vantage', 'rank', 'domain', 'kind'];
const REQUEST_ROW_KEYS = new Set([
  ...COMMON_ROW_KEYS,
  'dialect',
  'dialect_kind',
  'robots',
  'requested',
  'outcome',
  'error',
  'error_detail',
  'elapsed_ms',
  'status',
  'redirected',
  'redirect_target_host',
  'redirect_target_scheme',
  'redirect_cross_origin',
  'final_host',
  'challenge',
  'toll',
  'server',
  'x_robots_tag',
  'cf_ray',
]);
const FILE_ROW_KEYS = new Set([
  ...COMMON_ROW_KEYS,
  'file',
  'status',
  'error',
  'bytes',
  'challenge',
  'truncated',
  'present',
  'soft_404',
  'outcome',
  'content_type',
  'redirected',
  'redirect_target_host',
  'redirect_target_scheme',
  'redirect_hops',
  'redirect_chain',
  'redirect_refusal',
  'final_host',
]);
const REDIRECT_HOP_KEYS = new Set(['status', 'target_host', 'target_scheme', 'cross_authority']);
const ROBOTS_KEYS = new Set(['allowed', 'reason', 'rule', 'group', 'explicit', 'known']);
const TOLL_KEYS = new Set(['status_402', 'header_names']);
const OUTCOMES = new Set([
  'reachable',
  'error',
  'challenged',
  'denied_by_robots',
  'blocked',
  'client_error',
  'other',
  'rate_limited',
  'toll',
  'server_error',
  'auth_required',
  'legal_block',
  'redirected',
]);
const TOLL_HEADER_NAMES = new Set([
  'crawler-price',
  'x-payment',
  'x-payment-required',
  'x402-price',
  'payment-required',
  'signature-agent',
  'www-authenticate',
]);
const FORBIDDEN_KEYS = new Set([
  'body',
  'headers',
  'ua',
  'cookie',
  'cookies',
  'set-cookie',
  'authorization',
  'proxy-authorization',
]);
const SECRET_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/,
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(message) {
  throw new Error(`run validation failed: ${message}`);
}

function readInputList(file, limit = Infinity) {
  const bytes = readFileSync(file);
  const rows = new Map();
  for (const line of bytes.toString('utf8').trim().split(/\r?\n/)) {
    if (!line) continue;
    const [rankRaw, domainRaw] = line.split(',');
    const rank = Number(rankRaw);
    const domain = domainRaw?.trim();
    if (!Number.isInteger(rank) || rank < 1 || !domain) fail(`invalid input-list row: ${line}`);
    if (rows.has(rank)) fail(`duplicate input rank ${rank}`);
    rows.set(rank, domain);
    if (rows.size >= limit) break;
  }
  if (rows.size === 0) fail('input list is empty');
  return { bytes, rows };
}

function scanValue(value, path = '') {
  if (typeof value === 'string') {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(value)) fail(`credential-shaped value at ${path || '<root>'}`);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_KEYS.has(lower)) fail(`forbidden stored key ${path}${key}`);
    scanValue(nested, `${path}${key}.`);
  }
}

function assertKeys(value, allowed, label, line) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`invalid ${label} at line ${line}`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`unapproved ${label} key ${key} at line ${line}`);
  }
}

export function validateRun(file, { run, list, vantage, allowPartial = false, limit = Infinity }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(run)) fail('invalid run identity');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(vantage)) fail('invalid vantage identity');
  const expectedNames = allowPartial ? [`${run}.jsonl`, `${run}.jsonl.partial`] : [`${run}.jsonl`];
  if (!expectedNames.includes(basename(file))) fail('capture filename does not match run identity');

  if (limit !== Infinity && (!Number.isInteger(limit) || limit < 1)) fail('invalid input limit');
  const { bytes: inputBytes, rows: inputRows } = readInputList(list, limit);
  const data = readFileSync(file);
  if (!data.length) fail('dataset is empty');
  if (data[data.length - 1] !== 0x0a) fail('dataset is not newline-terminated');

  const rowIds = new Set();
  const perDomain = new Map();
  const outcomes = Object.create(null);
  const dialects = Object.create(null);
  const files = Object.create(null);
  let requestRows = 0;
  let fileRows = 0;
  let observedFrom = null;
  let observedThrough = null;

  const lines = data.toString('utf8').trimEnd().split('\n');
  for (let index = 0; index < lines.length; index++) {
    let row;
    try {
      row = JSON.parse(lines[index]);
    } catch {
      fail(`invalid JSON at line ${index + 1}`);
    }
    // Exact, and read from tools/policy.mjs rather than typed here. A capture is
    // only publishable under the schema this instrument declares in its own
    // manifest; a mixed-schema file would be two instruments in one dataset.
    if (row.schema_version !== ROW_SCHEMA_VERSION) fail(`line ${index + 1} has schema ${row.schema_version}`);
    if (row.run !== run) fail(`mixed run identity at line ${index + 1}`);
    if (row.vantage !== vantage) fail(`mixed vantage identity at line ${index + 1}`);
    const expectedDomain = inputRows.get(row.rank);
    if (!expectedDomain || expectedDomain !== row.domain) {
      fail(`line ${index + 1} is outside the pinned input list`);
    }
    if (!Number.isFinite(Date.parse(row.ts))) fail(`invalid timestamp at line ${index + 1}`);
    observedFrom = observedFrom === null || row.ts < observedFrom ? row.ts : observedFrom;
    observedThrough = observedThrough === null || row.ts > observedThrough ? row.ts : observedThrough;
    scanValue(row);

    let identity;
    if (row.kind === 'request') {
      assertKeys(row, REQUEST_ROW_KEYS, 'request row', index + 1);
      if (!DIALECTS.includes(row.dialect)) fail(`unknown dialect at line ${index + 1}`);
      identity = `request:${row.dialect}`;
      requestRows++;
      dialects[row.dialect] = (dialects[row.dialect] || 0) + 1;
      if (!OUTCOMES.has(row.outcome)) fail(`unknown request outcome at line ${index + 1}`);
      outcomes[row.outcome] = (outcomes[row.outcome] || 0) + 1;
      if (!row.robots || typeof row.robots.allowed !== 'boolean') fail(`missing robots verdict at line ${index + 1}`);
      assertKeys(row.robots, ROBOTS_KEYS, 'robots verdict', index + 1);
      if (typeof row.requested !== 'boolean') fail(`missing requested flag at line ${index + 1}`);
      if (row.requested === true && row.robots.allowed !== true) fail(`request bypassed robots at line ${index + 1}`);
      if (row.requested === false && row.outcome !== 'denied_by_robots') fail(`unrequested row has wrong outcome at line ${index + 1}`);
      if (row.toll !== null && row.toll !== undefined) {
        assertKeys(row.toll, TOLL_KEYS, 'toll', index + 1);
        if (row.toll.header_names !== undefined) {
          if (!Array.isArray(row.toll.header_names)) fail(`invalid toll header names at line ${index + 1}`);
          for (const name of row.toll.header_names) {
            if (!TOLL_HEADER_NAMES.has(name)) fail(`unapproved toll header name at line ${index + 1}`);
          }
        }
      }
    } else if (row.kind === 'file') {
      assertKeys(row, FILE_ROW_KEYS, 'file row', index + 1);
      if (!FILES.includes(row.file)) fail(`unknown file observation at line ${index + 1}`);
      if (row.redirect_chain !== undefined) {
        if (!Array.isArray(row.redirect_chain)) fail(`invalid redirect chain at line ${index + 1}`);
        // The chain is the audit trail for a followed policy document, so its
        // length has to agree with the count published beside it — two fields
        // describing one thing are a place for a discrepancy to hide.
        if (row.redirect_hops !== row.redirect_chain.length) {
          fail(`redirect hop count disagrees with the chain at line ${index + 1}`);
        }
        if (row.redirect_chain.length > 6) fail(`redirect chain exceeds the follow budget at line ${index + 1}`);
        for (const hop of row.redirect_chain) {
          assertKeys(hop, REDIRECT_HOP_KEYS, 'redirect hop', index + 1);
          if (!Number.isInteger(hop.status) || hop.status < 300 || hop.status > 399) {
            fail(`non-redirect status in redirect chain at line ${index + 1}`);
          }
        }
      }
      identity = `file:${row.file}`;
      fileRows++;
      files[row.file] = (files[row.file] || 0) + 1;
    } else {
      fail(`unknown row kind at line ${index + 1}`);
    }

    const id = `${row.rank}\0${row.domain}\0${identity}`;
    if (rowIds.has(id)) fail(`duplicate row identity at line ${index + 1}`);
    rowIds.add(id);
    perDomain.set(row.domain, (perDomain.get(row.domain) || 0) + 1);
  }

  const expectedRows = inputRows.size * (DIALECTS.length + FILES.length);
  if (lines.length !== expectedRows) fail(`expected ${expectedRows} rows, got ${lines.length}`);
  if (requestRows !== inputRows.size * DIALECTS.length) fail('request-row count mismatch');
  if (fileRows !== inputRows.size * FILES.length) fail('file-row count mismatch');
  if (perDomain.size !== inputRows.size) fail('domain count mismatch');
  for (const [rank, domain] of inputRows) {
    if (perDomain.get(domain) !== DIALECTS.length + FILES.length) fail(`incomplete domain at rank ${rank}`);
  }
  for (const id of DIALECTS) if (dialects[id] !== inputRows.size) fail(`dialect count mismatch: ${id}`);
  for (const id of FILES) if (files[id] !== inputRows.size) fail(`file count mismatch: ${id}`);

  return {
    bytes: data.length,
    sha256: sha256(data),
    rows: lines.length,
    domains: inputRows.size,
    rows_per_domain: DIALECTS.length + FILES.length,
    request_rows: requestRows,
    file_rows: fileRows,
    observed_from: observedFrom,
    observed_through: observedThrough,
    outcomes: Object.fromEntries(Object.entries(outcomes).sort()),
    dialects: Object.fromEntries(Object.entries(dialects).sort()),
    files: Object.fromEntries(Object.entries(files).sort()),
    input_sha256: sha256(inputBytes),
  };
}

function sidecars(file, run) {
  return {
    manifest: join(dirname(file), `${run}.manifest.json`),
    checksum: join(dirname(file), `${run}.sha256`),
  };
}

export function createArtifacts(file, options, provenance) {
  const summary = validateRun(file, options);
  const paths = sidecars(file, options.run);
  if (existsSync(paths.manifest) || existsSync(paths.checksum)) fail('release sidecar already exists');
  const manifest = {
    schema_version: 3,
    capture_id: options.run,
    scheduled_slot: provenance.scheduled_slot,
    // WHEN the instrument looked, as a repeatable slot rather than an instant.
    // Every other comparability dimension describes how the instrument was
    // configured; none of them described the hour, and the first two automated
    // captures were fourteen hours apart with zero confounders reported.
    observation_window: observationWindow(provenance.scheduled_slot, summary.observed_from),
    observed_from: summary.observed_from,
    observed_through: summary.observed_through,
    instrument_commit: provenance.instrument_sha,
    workflow: {
      repository: provenance.repository,
      run_id: provenance.workflow_run_id,
      run_attempt: provenance.workflow_run_attempt,
      url: provenance.workflow_url,
    },
    vantage: {
      id: options.vantage,
      class: 'github-hosted-dynamic-egress',
      runner_os: provenance.runner_os,
      runner_arch: provenance.runner_arch,
      runner_image: provenance.runner_image,
    },
    // Half of the comparability contract. The other half is the vantage above:
    // a capture may only be differenced against another capture that agrees on
    // both, and tools/compare.mjs enforces that rather than trusting a reader
    // to remember it. See tools/policy.mjs for why this is a gate and not a note.
    instrument_policy: INSTRUMENT_POLICY,
    input: {
      name: options.list,
      sha256: summary.input_sha256,
    },
    dataset: {
      name: basename(file),
      sha256: summary.sha256,
      bytes: summary.bytes,
      rows: summary.rows,
      domains: summary.domains,
      rows_per_domain: summary.rows_per_domain,
      request_rows: summary.request_rows,
      file_rows: summary.file_rows,
    },
    request_outcomes: summary.outcomes,
    dialect_counts: summary.dialects,
    file_counts: summary.files,
    privacy: {
      response_bodies_stored: false,
      cookies_stored: false,
      presented_user_agent_strings_stored: false,
      general_response_header_maps_stored: false,
      selected_header_metadata: ['server', 'x_robots_tag', 'content_type', 'cf_ray boolean', 'toll.header_names allowlist'],
    },
    identity_note: 'GPTBot and ClaudeBot rows are disclosed simulations, not authenticated vendor traffic.',
    // Derived, never carried forward, and recomputed from the published bytes on
    // the verify pass: a manifest number that cannot be regenerated from the
    // dataset it describes is a hand-maintained summary waiting to drift.
    aggregates: aggregateFile(file),
  };
  writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  writeFileSync(paths.checksum, `${summary.sha256}  ${basename(file)}\n`, { flag: 'wx' });
  return { ...paths, manifest: manifest, summary };
}

export function verifyArtifacts(file, options, expected = {}) {
  const summary = validateRun(file, options);
  const paths = sidecars(file, options.run);
  const manifest = JSON.parse(readFileSync(paths.manifest, 'utf8'));
  const checksum = readFileSync(paths.checksum, 'utf8');
  if (manifest.capture_id !== options.run) fail('manifest capture identity mismatch');
  if (manifest.vantage?.id !== options.vantage) fail('manifest vantage mismatch');
  if (manifest.dataset?.sha256 !== summary.sha256) fail('manifest dataset hash mismatch');
  if (manifest.dataset?.bytes !== summary.bytes || manifest.dataset?.rows !== summary.rows) fail('manifest dataset shape mismatch');
  if (manifest.input?.sha256 !== summary.input_sha256) fail('manifest input hash mismatch');
  if (expected.instrument_sha && manifest.instrument_commit !== expected.instrument_sha) fail('manifest instrument commit mismatch');
  if (expected.repository && manifest.workflow?.repository !== expected.repository) fail('manifest repository mismatch');
  if (expected.workflow_run_id && manifest.workflow?.run_id !== expected.workflow_run_id) fail('manifest workflow run mismatch');
  if (expected.workflow_run_attempt && manifest.workflow?.run_attempt !== expected.workflow_run_attempt) fail('manifest workflow attempt mismatch');
  if (expected.scheduled_slot && manifest.scheduled_slot !== expected.scheduled_slot) fail('manifest scheduled slot mismatch');
  if (checksum !== `${summary.sha256}  ${basename(file)}\n`) fail('checksum sidecar mismatch');
  // The comparability contract and the derived numbers are re-derived here from
  // the same bytes that are about to be published. This is the pass that would
  // catch a manifest edited between capture and publication, and the only reason
  // the aggregates on a release can be trusted without re-running the tool.
  if (JSON.stringify(manifest.instrument_policy) !== JSON.stringify(INSTRUMENT_POLICY)) {
    fail('manifest instrument policy does not match this instrument');
  }
  // Re-derived from the two fields it is a function of, for the same reason the
  // aggregates are: a comparability dimension that could be edited between
  // capture and publication is not a control.
  if (
    JSON.stringify(manifest.observation_window) !==
    JSON.stringify(observationWindow(manifest.scheduled_slot, summary.observed_from))
  ) {
    fail('manifest observation window is not reproducible from the schedule and the observations');
  }
  if (JSON.stringify(manifest.aggregates) !== JSON.stringify(aggregateFile(file))) {
    fail('manifest aggregates are not reproducible from the dataset');
  }
  return summary;
}

function cliOpt(args, name, fallback = undefined) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

async function main() {
  const args = process.argv.slice(2);
  const file = cliOpt(args, '--file');
  const run = cliOpt(args, '--run');
  const list = cliOpt(args, '--list', 'data/domains/tranco-74V8X-1000.csv');
  const vantage = cliOpt(args, '--vantage');
  if (!file || !run || !vantage) throw new Error('--file, --run, and --vantage are required');
  const options = { run, list, vantage };

  if (args.includes('--verify-only')) {
    const summary = verifyArtifacts(file, options, {
      instrument_sha: cliOpt(args, '--instrument-sha'),
      repository: cliOpt(args, '--repository'),
      workflow_run_id: cliOpt(args, '--workflow-run-id'),
      workflow_run_attempt: cliOpt(args, '--workflow-run-attempt'),
      scheduled_slot: cliOpt(args, '--scheduled-slot'),
    });
    console.log(JSON.stringify({ verified: true, ...summary }));
    return;
  }

  const required = (name) => {
    const value = cliOpt(args, name);
    if (!value) throw new Error(`${name} is required when creating artifacts`);
    return value;
  };
  const result = createArtifacts(file, options, {
    scheduled_slot: required('--scheduled-slot'),
    instrument_sha: required('--instrument-sha'),
    repository: required('--repository'),
    workflow_run_id: required('--workflow-run-id'),
    workflow_run_attempt: required('--workflow-run-attempt'),
    workflow_url: required('--workflow-url'),
    runner_os: required('--runner-os'),
    runner_arch: required('--runner-arch'),
    runner_image: cliOpt(args, '--runner-image', 'unknown'),
  });
  console.log(JSON.stringify({ finalized: true, manifest: result.manifest.dataset, outcomes: result.summary.outcomes }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
