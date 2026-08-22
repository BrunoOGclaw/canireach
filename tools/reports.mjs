// Crowd reports: the envelope, and the quarantine state machine that decides
// which of them are ever allowed to become data.
//
// WHY THIS FILE EXISTS. Our own probes are ground truth: one vantage, one hour,
// one thousand domains. The reason to accept reports from other agents at all is
// that they see doors we cannot — other networks, other hours, other identities,
// authenticated sessions we will never hold. The reason to distrust them is that
// a report costs nothing to fabricate, and this project's headline claim is a
// before/after about access. An access map that can be written to by anyone who
// wants a particular answer is not a map.
//
// So the rule is: NOTHING a stranger sends us is data when it arrives. Every
// accepted report enters `quarantined` and stays there until evidence we did not
// receive from the reporter promotes it. State is DERIVED from the evidence on
// every call, never stored and never set by hand — the same discipline the
// aggregates follow, and for the same reason: a state field somebody can write
// is a state field that drifts away from what actually justified it.
//
// THE FAILURE THIS FILE IS MOST BUILT AGAINST. The agreed kill metric is a
// COUNT of external reports. That makes our own go/no-go decision the exact
// quantity an adversary — or an over-eager us — has the cheapest possible means
// to inflate. Three separate defences follow from that and none of them are
// optional:
//
//   1. A submission is not an observation. One reporter retrying is one
//      observation, so exact resubmissions collapse on `submission_key` before
//      anything counts them.
//   2. An identity is not free. Corroboration-by-count is available only to
//      reporters bound to a key we verified (Web Bot Auth). A `reporter_id`
//      anybody can type is worth zero toward promotion, no matter how many of
//      them agree, because minting a thousand of them costs one loop.
//   3. The counts are reported separately and never added. `submissions`,
//      `claims`, `corroborated_claims` and `distinct_verified_identities` are
//      four different numbers, and quoting the largest one as if it were the
//      smallest is how a dataset manufactures its own launch.
//
// RAILS (charter): reports carry NO page content, NO headers, NO cookies, NO IP
// addresses, NO URLs beyond a bare hostname, and NO personal data. That is
// enforced by an allowlist — an unknown key is a rejection, not a strip — and
// the allowlist itself is guarded, because a denylist only ever covers what its
// author thought of and this repository has now paid for that lesson four times.
//
// There is deliberately NO write endpoint here. This module is the schema and
// the state machine; the ingest surface it will sit behind does not exist yet
// and is not authorised to exist unauthenticated.

import { createHash } from 'node:crypto';
import { DIALECTS } from './dialects.mjs';

export const REPORT_SCHEMA_VERSION = 1;

// --- vocabulary -------------------------------------------------------------

/**
 * Outcomes a report may claim. This list is deliberately the probe's own
 * vocabulary: a report that cannot be spelled the way a capture is spelled can
 * never be matched against one, and the two lists silently diverging would
 * disable corroboration without failing anything. tools/test-reports.mjs derives
 * the probe's real vocabulary by RUNNING its classifier over a status sweep and
 * fails if this list does not cover it.
 */
export const OUTCOMES = [
  'reachable',
  'blocked',
  'challenged',
  'toll',
  'rate_limited',
  'auth_required',
  'legal_block',
  'redirected',
  'client_error',
  'server_error',
  'denied_by_robots',
  'error',
  'other',
];

/**
 * What identity the reporter was presenting when it saw this. Not a user-agent
 * string — we do not want the string, and storing one would let a reporter push
 * arbitrary text into the dataset. The class is the part that carries meaning.
 */
export const DIALECT_CLASSES = [
  'human-baseline',
  'naive-script',
  'self-identified-agent',
  'vendor-token',
  'signed-agent',
  'unrecorded',
];

/**
 * How the reporter came to believe the outcome. Ordered weakest to strongest,
 * but NOT summed into a score: a score lets a pile of weak evidence outvote the
 * absence of strong evidence, which is the mechanism by which crowd data goes
 * bad. Evidence class gates what a report is eligible for, and nothing else.
 */
export const EVIDENCE_CLASSES = [
  // Somebody says so. Retained, never promotable on its own.
  'assertion',
  // The reporter's own runtime saw the status code in its request loop.
  'observed_status',
  // ...and the observation was produced by an automated probe, not a recollection.
  'automated_probe',
];

/** Evidence too weak to be promoted by any amount of agreement. */
const UNPROMOTABLE_EVIDENCE = new Set(['assertion']);

/**
 * Reporter identity classes, and what each is allowed to do.
 *
 * `verified` is the whole point. A self-declared id is a string; a Web Bot Auth
 * key thumbprint is a key the reporter had to hold. Only the latter counts
 * toward "multiple independent reporters", because independence has to cost
 * something or it is not independence — it is one actor with a for-loop.
 *
 * A self-declared reporter with a long probe-matched history should eventually
 * earn standing. That is a reputation system, it is NOT built here, and it is
 * named rather than quietly omitted: until it exists, unsigned reporters are
 * promotable only by an owned-probe match.
 */
export const IDENTITY_CLASSES = {
  anonymous: { verified: false, requires_thumbprint: false },
  self_declared: { verified: false, requires_thumbprint: false },
  web_bot_auth: { verified: true, requires_thumbprint: true },
};

/**
 * Where the reporter was standing. The project spent three captures establishing
 * that a delta across two vantage classes describes the instrument rather than
 * the web; corroboration is a comparison too, and the same rule applies to it.
 */
export const VANTAGE_CLASSES = [
  'residential',
  'mobile',
  'datacenter',
  'cloud-function',
  'github-hosted-dynamic-egress',
  'unrecorded',
];

// --- limits, all named and all enforced -------------------------------------

/** Distinct verified identities needed to promote a claim without a probe match. */
export const MIN_INDEPENDENT_REPORTERS = 2;

/**
 * How far a report's observation may sit from a capture's and still be treated
 * as being about the same conditions. Beyond this the capture is not evidence
 * about the report's moment: challenge rates and rate limits are not hour-
 * invariant, which is exactly why `observation_window` became a comparability
 * dimension in the first place.
 */
export const PROBE_MATCH_MAX_LAG_MINUTES = 180;

/** Observations are grouped into buckets this wide before they can corroborate. */
export const CLAIM_WINDOW_MINUTES = 60;

/** Reports are discarded this long after receipt. Stated so it is a contract. */
export const RETENTION_DAYS = 90;

/** Abuse ceilings, per identity per rolling day. Anonymous is held much tighter. */
export const RATE_LIMITS = { verified: 5000, self_declared: 500, anonymous: 50 };

/** A reporter's clock may run ahead of ours by this much before we disbelieve it. */
const CLOCK_SKEW_TOLERANCE_MINUTES = 5;

/** A report about something older than this is not rejected — but cannot corroborate. */
export const MAX_REPORT_LAG_DAYS = 7;

// --- the envelope -----------------------------------------------------------

/**
 * The complete accepted shape. An allowlist, checked recursively: any key not
 * named here is a rejection.
 *
 * Note what is absent and cannot be added by accident: no `url`, `path`,
 * `headers`, `body`, `ua`, `cookie`, or `ip`. A bare hostname is the finest
 * granularity we accept, because a full URL is a place a session token or a
 * private document name arrives in our dataset without anyone intending it.
 */
export const ENVELOPE = {
  schema_version: { type: 'integer', required: true, equals: REPORT_SCHEMA_VERSION },
  report_id: { type: 'token', required: true, maxLength: 120 },
  domain: { type: 'hostname', required: true },
  observed_at: { type: 'timestamp', required: true },
  dialect_class: { type: 'enum', required: true, values: DIALECT_CLASSES },
  outcome: { type: 'enum', required: true, values: OUTCOMES },
  evidence_class: { type: 'enum', required: true, values: EVIDENCE_CLASSES },
  vantage_class: { type: 'enum', required: true, values: VANTAGE_CLASSES },
  status: { type: 'status', required: false },
  challenge_vendor: { type: 'token', required: false, maxLength: 40 },
  reporter: {
    type: 'object',
    required: true,
    fields: {
      identity_class: { type: 'enum', required: true, values: Object.keys(IDENTITY_CLASSES) },
      // The Web Bot Auth key thumbprint, verified by the ingest surface BEFORE
      // this module ever sees it. Presence here is a claim that a signature
      // checked out; this module's job is what follows from that, not the crypto.
      key_thumbprint: { type: 'token', required: false, maxLength: 120 },
    },
  },
};

/**
 * Field names that must never appear anywhere in the envelope. This does NOT
 * filter incoming reports — the allowlist above already does that, and a second
 * filter on the data would be belt-and-braces on the wrong object.
 *
 * It guards the SCHEMA. The realistic way page content ends up in this dataset
 * is not a clever attacker; it is a future change that widens the allowlist by
 * one convenient field. Then the rails are broken and every test still passes,
 * because the tests describe the fields that exist. So the tripwire is on the
 * allowlist itself and it fails the build the moment the field is added.
 */
export const FORBIDDEN_FIELD_NAMES = [
  'body', 'content', 'html', 'text', 'snippet',
  'headers', 'header', 'cookie', 'cookies', 'set_cookie',
  'ua', 'user_agent', 'useragent',
  'ip', 'ip_address', 'remote_addr', 'client_ip',
  'url', 'path', 'query', 'referrer', 'referer',
  'email', 'name', 'user', 'username', 'account', 'session', 'token', 'auth', 'key',
];

/**
 * Fails if the envelope ever grows a field the rails forbid. Called by the test
 * suite; cheap enough to also call from an ingest surface's startup.
 */
export function assertEnvelopeCarriesNoForbiddenField(envelope = ENVELOPE) {
  const forbidden = new Set(FORBIDDEN_FIELD_NAMES);
  const offenders = [];
  const walk = (spec, prefix) => {
    for (const [key, def] of Object.entries(spec)) {
      const path = prefix ? `${prefix}.${key}` : key;
      // `key_thumbprint` contains "key" as a word but is a hash of a PUBLIC key,
      // which is the opposite of a secret. Matching whole names, not substrings,
      // is the difference between a guard and the merge gate's "stripe" incident.
      if (forbidden.has(key)) offenders.push(path);
      if (def.type === 'object' && def.fields) walk(def.fields, path);
    }
  };
  walk(envelope, '');
  if (offenders.length) {
    throw new Error(`envelope carries forbidden field(s): ${offenders.join(', ')}`);
  }
  return true;
}

// --- validation -------------------------------------------------------------

const HOSTNAME = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function checkField(value, def, path, errors) {
  switch (def.type) {
    case 'integer':
      if (!Number.isInteger(value)) errors.push(`${path}: not an integer`);
      else if (def.equals !== undefined && value !== def.equals) {
        errors.push(`${path}: expected ${def.equals}`);
      }
      break;
    case 'token':
      if (typeof value !== 'string' || !TOKEN.test(value)) errors.push(`${path}: not a token`);
      else if (value.length > def.maxLength) errors.push(`${path}: longer than ${def.maxLength}`);
      break;
    case 'hostname':
      // Lowercased, no scheme, no port, no path. Anything richer is a URL, and
      // a URL is the thing we promised not to store.
      if (typeof value !== 'string' || !HOSTNAME.test(value)) errors.push(`${path}: not a bare hostname`);
      break;
    case 'timestamp': {
      if (typeof value !== 'string') { errors.push(`${path}: not a timestamp`); break; }
      const t = Date.parse(value);
      if (Number.isNaN(t)) errors.push(`${path}: unparseable timestamp`);
      break;
    }
    case 'enum':
      if (!def.values.includes(value)) errors.push(`${path}: not one of ${def.values.join('|')}`);
      break;
    case 'status':
      if (value !== null && !(Number.isInteger(value) && value >= 100 && value <= 599)) {
        errors.push(`${path}: not an HTTP status`);
      }
      break;
    case 'object':
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${path}: not an object`);
      }
      break;
    default:
      errors.push(`${path}: unknown field type`);
  }
}

function validateShape(value, spec, prefix, errors) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${prefix || 'report'}: not an object`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!(key in spec)) errors.push(`${prefix ? `${prefix}.` : ''}${key}: unknown field`);
  }
  for (const [key, def] of Object.entries(spec)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in value) || value[key] === undefined) {
      if (def.required) errors.push(`${path}: missing`);
      continue;
    }
    checkField(value[key], def, path, errors);
    if (def.type === 'object' && def.fields && value[key] && typeof value[key] === 'object') {
      validateShape(value[key], def.fields, path, errors);
    }
  }
}

/**
 * Validate one report against the envelope and the plausibility rules.
 *
 * `receivedAt` is OUR clock, and it is not optional. A reporter chooses
 * `observed_at`; if the only timestamp in the record were the one the reporter
 * chose, an actor could place an observation inside a capture's window on
 * purpose and manufacture a probe match. Both are stored, and disagreement
 * between them is itself a finding.
 */
export function validateReport(report, receivedAt) {
  const errors = [];
  validateShape(report, ENVELOPE, '', errors);

  const received = Date.parse(receivedAt ?? '');
  if (Number.isNaN(received)) errors.push('received_at: unparseable');

  if (!errors.length) {
    const identity = IDENTITY_CLASSES[report.reporter.identity_class];
    const thumbprint = report.reporter.key_thumbprint;
    if (identity.requires_thumbprint && !thumbprint) {
      errors.push('reporter.key_thumbprint: required for a verified identity class');
    }
    // An unverified class carrying a thumbprint is rejected rather than ignored.
    // Silently dropping it would leave a record that LOOKS bound to a key while
    // counting as unbound, and every reader of the ledger would have to know.
    if (!identity.requires_thumbprint && thumbprint) {
      errors.push('reporter.key_thumbprint: present on an unverified identity class');
    }

    const observed = Date.parse(report.observed_at);
    const skewMs = CLOCK_SKEW_TOLERANCE_MINUTES * 60_000;
    if (observed > received + skewMs) errors.push('observed_at: in the future relative to receipt');
  }

  return { valid: errors.length === 0, errors };
}

// --- keys -------------------------------------------------------------------

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 32);

/**
 * Collapses exact resubmissions. Scoped to the REPORTER, on purpose: two
 * different agents that happen to choose the same `report_id` are two
 * observations and must not erase each other.
 */
export function submissionKey(report) {
  const r = report.reporter;
  const identity = r.key_thumbprint ? `k:${r.key_thumbprint}` : `c:${r.identity_class}`;
  return sha(`${identity}|${report.report_id}`);
}

/**
 * The corroboration group: one specific claim about one door at one hour.
 *
 * KEEPING THIS DISTINCT FROM `submissionKey` IS THE POINT. Collapse them into a
 * single "deduplication key" and one reporter pressing retry four times becomes
 * four agreeing observers. The two keys answer different questions — "have I
 * already got this exact submission?" and "what else was said about this same
 * thing?" — and only the second is ever counted.
 *
 * The outcome is IN the key so that disagreement forms a separate group rather
 * than being averaged into agreement. `contested` is then something the
 * resolver can see, instead of something that quietly cancels out.
 */
export function claimKey(report) {
  return sha(
    [report.domain, report.dialect_class, report.outcome, windowBucket(report.observed_at)].join('|'),
  );
}

/** UTC bucket of width CLAIM_WINDOW_MINUTES, as an ISO-ish label. */
export function windowBucket(iso) {
  const ms = Date.parse(iso);
  const width = CLAIM_WINDOW_MINUTES * 60_000;
  return new Date(Math.floor(ms / width) * width).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// --- the state machine ------------------------------------------------------

export const STATES = ['quarantined', 'corroborated', 'contested', 'expired'];

/**
 * Owned-probe evidence, extracted from a capture. Shaped deliberately thin: the
 * resolver is given outcomes we measured, not a whole dataset to rummage in.
 *
 * `observed_at` is the capture's own `observed_from`, and `vantage_class` its
 * manifest vantage class — both are required, because a probe match asserted
 * without them is a comparison across unrecorded conditions, which is the
 * failure `tools/compare.mjs` exists to refuse one layer up.
 */
export function probeEvidenceFromCapture(manifest, rows) {
  const observedAt = manifest.observed_from;
  const vantageClass = manifest.vantage?.class ?? 'unrecorded';
  return rows
    .filter((r) => r.kind === 'request' && r.outcome)
    .map((r) => ({
      domain: r.domain,
      dialect_class: DIALECT_TO_CLASS[r.dialect] ?? 'unrecorded',
      outcome: r.outcome,
      observed_at: r.ts ?? observedAt,
      vantage_class: vantageClass,
      capture_id: manifest.capture_id,
    }));
}

/**
 * Probe `kind` -> the class a reporter names. The only entry that is not the
 * identity function is the vendor one: our probe's kind records that the vendor
 * token was DISCLOSED (we appended a "not the named vendor" notice), which is a
 * fact about our instrument and not about the reporter's.
 */
const KIND_TO_CLASS = {
  'human-baseline': 'human-baseline',
  'naive-script': 'naive-script',
  'self-identified-agent': 'self-identified-agent',
  'vendor-token-disclosed': 'vendor-token',
};

/**
 * Probe dialect id -> reporter dialect class, DERIVED from the dialect registry
 * rather than restated beside it.
 *
 * Written out by hand this table would be a control that drifts: add a sixth
 * dialect to dialects.mjs and its rows would quietly map to `unrecorded`, which
 * never equals anything, so every capture row for that identity would silently
 * stop being able to corroborate anything — no error, no red test, just a
 * corroboration path that goes dead. Deriving it turns that into a throw at
 * import time, which the suite sees immediately.
 *
 * Takes the registry as an argument rather than closing over it, because the
 * clause that matters is unreachable from the registry we actually ship: every
 * kind in dialects.mjs is mapped today, so a test using the real registry cannot
 * distinguish this throw from a silent fallback. The suite hands it a dialect
 * whose kind should never exist, which is exactly why the guard exists.
 */
export function dialectClassMap(dialects) {
  return Object.fromEntries(
    dialects.map((d) => {
      const cls = KIND_TO_CLASS[d.kind];
      if (!cls) throw new Error(`dialect '${d.id}' has kind '${d.kind}' with no reporter class`);
      if (!DIALECT_CLASSES.includes(cls)) throw new Error(`reporter class '${cls}' is not in DIALECT_CLASSES`);
      return [d.id, cls];
    }),
  );
}

export const DIALECT_TO_CLASS = dialectClassMap(DIALECTS);

function minutesApart(a, b) {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 60_000;
}

/**
 * Does any owned probe corroborate this claim?
 *
 * Requires agreement on domain, dialect class AND outcome, and requires the
 * observations to be within PROBE_MATCH_MAX_LAG_MINUTES of each other. The lag
 * bound is not decoration: our capture is one instant per night, and a probe
 * from fourteen hours earlier agreeing with a report is a coincidence of the
 * clock, not corroboration.
 */
function probeMatch(report, probeEvidence) {
  for (const p of probeEvidence) {
    if (p.domain !== report.domain) continue;
    if (p.dialect_class !== report.dialect_class) continue;
    if (p.outcome !== report.outcome) continue;
    if (minutesApart(p.observed_at, report.observed_at) > PROBE_MATCH_MAX_LAG_MINUTES) continue;
    return p;
  }
  return null;
}

/**
 * Resolve a ledger of accepted reports into claim groups with derived states.
 *
 * `now` is required rather than defaulted to the wall clock: a resolver whose
 * output depends on when it happened to run is not reproducible, and every
 * published number in this project has to be recomputable by a stranger.
 */
export function resolve(ledger, { probeEvidence = [], now }) {
  if (!now) throw new Error('resolve() requires an explicit `now`');
  const nowMs = Date.parse(now);
  const retentionMs = RETENTION_DAYS * 86_400_000;
  const maxLagMs = MAX_REPORT_LAG_DAYS * 86_400_000;

  // 1. Collapse exact resubmissions. Earliest receipt wins; a later identical
  //    submission is not new information and must not become a second voice.
  const bySubmission = new Map();
  let duplicates = 0;
  for (const entry of ledger) {
    const key = submissionKey(entry.report);
    const seen = bySubmission.get(key);
    if (!seen) bySubmission.set(key, entry);
    else {
      duplicates++;
      if (Date.parse(entry.received_at) < Date.parse(seen.received_at)) bySubmission.set(key, entry);
    }
  }

  // 2. Group into claims.
  const groups = new Map();
  for (const entry of bySubmission.values()) {
    const key = claimKey(entry.report);
    if (!groups.has(key)) {
      groups.set(key, {
        claim_key: key,
        domain: entry.report.domain,
        dialect_class: entry.report.dialect_class,
        outcome: entry.report.outcome,
        window: windowBucket(entry.report.observed_at),
        reports: [],
      });
    }
    groups.get(key).reports.push(entry);
  }

  // 3. Derive each group's state from evidence only.
  const resolved = [];
  for (const group of groups.values()) {
    // Stable order inside the group, by submission key rather than by arrival.
    // Every state below is already order-independent, but the resolution is
    // meant to be published and hashed, and a document whose BYTES depend on
    // the order reports happened to arrive in is not reproducible by a stranger
    // — the same reason the series comparison breaks tag ties deterministically
    // instead of trusting the API's list order.
    group.reports.sort((x, y) => submissionKey(x.report).localeCompare(submissionKey(y.report)));

    const expired = group.reports.every((e) => nowMs - Date.parse(e.received_at) > retentionMs);

    // A report about something a week old is retained but cannot corroborate:
    // by then neither our probes nor another reporter can speak to that moment.
    const eligible = group.reports.filter(
      (e) =>
        !UNPROMOTABLE_EVIDENCE.has(e.report.evidence_class) &&
        Date.parse(e.received_at) - Date.parse(e.report.observed_at) <= maxLagMs,
    );

    const identities = new Set();
    for (const e of eligible) {
      const r = e.report.reporter;
      if (IDENTITY_CLASSES[r.identity_class].verified && r.key_thumbprint) identities.add(r.key_thumbprint);
    }

    let match = null;
    for (const e of eligible) {
      match = probeMatch(e.report, probeEvidence);
      if (match) break;
    }

    const reasons = [];
    if (match) reasons.push('owned_probe_match');
    if (identities.size >= MIN_INDEPENDENT_REPORTERS) reasons.push('independent_verified_reporters');

    resolved.push({
      ...group,
      submissions: group.reports.length,
      eligible: eligible.length,
      distinct_verified_identities: identities.size,
      verified_identities: [...identities].sort(),
      probe_match: match ? { capture_id: match.capture_id, vantage_class: match.vantage_class } : null,
      state: expired ? 'expired' : reasons.length ? 'corroborated' : 'quarantined',
      promotion_reasons: reasons,
    });
  }

  // 4. Contested: the same door, same identity class, same hour, two different
  //    outcomes both carrying standing. Publishing either as fact would be
  //    publishing a coin flip, so BOTH are demoted and the conflict is named.
  const byDoor = new Map();
  for (const g of resolved) {
    if (g.state !== 'corroborated') continue;
    const door = `${g.domain}|${g.dialect_class}|${g.window}`;
    if (!byDoor.has(door)) byDoor.set(door, []);
    byDoor.get(door).push(g);
  }
  for (const [door, gs] of byDoor) {
    if (gs.length < 2) continue;
    for (const g of gs) {
      g.state = 'contested';
      g.contested_with = gs.filter((o) => o !== g).map((o) => o.outcome);
      g.contested_door = door;
    }
  }

  return {
    resolved_at: now,
    duplicate_submissions: duplicates,
    claims: resolved.sort((a, b) => a.claim_key.localeCompare(b.claim_key)),
  };
}

/**
 * The four numbers, kept apart.
 *
 * `submissions` is what the kill metric counts and it is the WEAKEST of the
 * four. `corroborated_claims` is what may be published as access data. Reporting
 * one under the other's name is the denominator failure this project already ran
 * into once, where a choice of denominator moved a headline forty points.
 */
export function reportCounts(resolution) {
  const claims = resolution.claims;
  // Unioned across claims, not summed: one reporter that filed about forty
  // domains is one identity. Summing per-claim identity counts would report it
  // as forty, which is the same inflation the whole module is built against.
  const identities = new Set(claims.flatMap((c) => c.verified_identities ?? []));
  return {
    submissions: claims.reduce((n, c) => n + c.submissions, 0) + resolution.duplicate_submissions,
    distinct_submissions: claims.reduce((n, c) => n + c.submissions, 0),
    claims: claims.length,
    corroborated_claims: claims.filter((c) => c.state === 'corroborated').length,
    contested_claims: claims.filter((c) => c.state === 'contested').length,
    quarantined_claims: claims.filter((c) => c.state === 'quarantined').length,
    expired_claims: claims.filter((c) => c.state === 'expired').length,
    distinct_verified_identities: identities.size,
  };
}

/**
 * Identities over their daily ceiling. There is no enforcement surface yet
 * because there is no ingest surface yet; this exists so that the limits above
 * are a computation rather than a paragraph, and so the first endpoint has
 * something to call instead of inventing its own numbers.
 */
export function abuseFindings(ledger, { now }) {
  if (!now) throw new Error('abuseFindings() requires an explicit `now`');
  const since = Date.parse(now) - 86_400_000;
  const counts = new Map();
  for (const e of ledger) {
    if (Date.parse(e.received_at) < since) continue;
    const r = e.report.reporter;
    const id = r.key_thumbprint ? `k:${r.key_thumbprint}` : `c:${r.identity_class}`;
    const bucket = IDENTITY_CLASSES[r.identity_class].verified
      ? 'verified'
      : r.identity_class === 'anonymous'
        ? 'anonymous'
        : 'self_declared';
    const cur = counts.get(id) ?? { identity: id, bucket, count: 0 };
    cur.count++;
    counts.set(id, cur);
  }
  return [...counts.values()]
    .filter((c) => c.count > RATE_LIMITS[c.bucket])
    .map((c) => ({ ...c, limit: RATE_LIMITS[c.bucket] }));
}
