// The traveler's answer: what did this instrument last measure at a door, and when.
//
// This is the module behind the MCP tool an agent calls in its own loop. Every
// value it returns is derived from a capture whose bytes hashed to the SHA-256
// its manifest published, plus crowd claims that `tools/reports.mjs` has already
// promoted to `corroborated`. There is no hand-maintained table anywhere in the
// path, and there is no network call: a lookup tool that probes on demand is an
// on-request scanner pointed at arbitrary third parties, which the charter
// forbids. `tools/test-lookup.mjs` asserts both of those mechanically rather
// than trusting this paragraph.
//
// THE FAILURE MODE THIS FILE IS SHAPED AROUND is an answer that is confidently
// wrong because it is twelve hours old. Our capture is one instant per night;
// the caller's question is about now. Reachability is not hour-invariant — that
// is the finding that made `observation_window` a comparability dimension — so
// three things follow, and they are structural rather than documented:
//
//  1. NO FIELD IN THE ANSWER IS PRESENT-TENSE. There is no `reachable`, no
//     `blocked`, no `allowed`. Every behavioural value is `last_outcome` and
//     travels welded to `observed_at` and `age_minutes`. A consumer cannot read
//     a twelve-hour-old measurement as a live one because no key invites it to.
//     `assertNoPresentTenseField` enforces that on the rendered answer.
//  2. AGE IS CLASSIFIED AGAINST A RULE WE ALREADY MADE. `freshness` uses
//     PROBE_MATCH_MAX_LAG_MINUTES, imported from reports.mjs rather than
//     restated here. That constant already encodes this project's ruling that
//     two observations of the same door more than three hours apart are not
//     about the same conditions. The caller's "now" is just the second
//     observation. Restating the number would be a control that can drift from
//     the rule it implements.
//  3. A DOOR WE DID NOT KNOCK ON HAS NO BEHAVIOURAL ANSWER. See below; this is
//     the largest and least obvious source of confidently-wrong answers.
//
// THE not-attempted TRAP, stated plainly because it is most of the dataset.
// A request row carries `outcome: 'denied_by_robots'` in two very different
// situations, and the row's `robots.known` flag is what separates them:
//
//   robots.known === true   the site's robots.txt was read and it disallows this
//                           token. That is the SITE'S DECLARATION. Real, worth
//                           reporting, and still not behaviour — we never asked,
//                           so we do not know what the server would have done.
//   robots.known === false  robots.txt could not be read (a redirect, a
//                           challenge, a 5xx) and our policy fails closed. That
//                           is a fact about OUR INSTRUMENT and carries no
//                           information whatsoever about the site.
//
// In the 2026-08-22 automated captures, 4,055 of 5,000 request rows are
// `denied_by_robots` and the overwhelming majority are the second kind. An
// answer engine that flattened those into "blocked" would tell agents the web is
// shut against them on the strength of our own compliance and our own fail-closed
// default. That is the denominator failure this project already met once, where a
// choice of denominator moved a headline forty points — here it would move a
// per-domain answer from "we don't know" to "no", which is worse.
//
// So `last_outcome` is non-null ONLY when the request was actually sent.

import { PROBE_MATCH_MAX_LAG_MINUTES } from './reports.mjs';
import { SITE_FILES } from './dialects.mjs';

/** Doors we did knock on, doors we did not, and why not. */
export const EVIDENCE_KINDS = [
  // We sent a request and observed what came back. Only this kind carries a
  // `last_outcome`.
  'behaviour',
  // robots.txt was read and disallows this identity. The site's declaration; we
  // obeyed it. Says nothing about what the server would have done.
  'robots-declaration',
  // robots.txt was unreadable and our policy failed closed. A fact about this
  // instrument. Carries no information about the site.
  'not-attempted',
];

/**
 * Keys an answer may never contain.
 *
 * Not style policing. Each of these reads as a claim about the present, and
 * every number in this answer is a claim about a moment in the past. The one
 * that matters most is `allowed`: it is the probe row's own robots field name,
 * so re-emitting the row shape verbatim is the natural way to introduce it, and
 * an agent reading `allowed: false` on a door where robots.txt was merely
 * unreadable would be reading our fail-closed default as the site's answer.
 */
export const PRESENT_TENSE_FIELD_NAMES = [
  'reachable',
  'blocked',
  'allowed',
  'available',
  'online',
  'can_reach',
  'is_reachable',
  'status',
  'ok',
];

export function assertNoPresentTenseField(value, path = 'answer') {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoPresentTenseField(v, `${path}[${i}]`));
    return value;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (PRESENT_TENSE_FIELD_NAMES.includes(key)) {
        throw new Error(
          `${path}.${key} is a present-tense field name; this answer describes a past measurement`,
        );
      }
      assertNoPresentTenseField(value[key], `${path}.${key}`);
    }
  }
  return value;
}

/**
 * Host for a lookup.
 *
 * NO PARENT-DOMAIN FALLBACK, deliberately. `api.example.com` is not
 * `example.com`: they are frequently different infrastructure behind different
 * rules, and answering for the parent would be the inference this tool exists
 * not to make. An unprobed host returns `unknown`.
 */
export function normalizeDomain(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('domain must be a non-empty string');
  let raw = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`could not read a host out of '${input}'`);
    }
    raw = url.hostname;
  }
  const host = raw.replace(/\.$/, '').toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    throw new Error(`'${input}' is not a hostname this tool can look up`);
  }
  return host;
}

function affordanceState(row) {
  if (!row) return 'unknown';
  // A file we never fetched because the robots gate closed is UNKNOWN, not
  // absent. `present: false` on such a row means "not checked" — the same shape
  // as the not-attempted trap one layer down, and aggregate.mjs already counts
  // these apart as `not_checked` rather than folding them into absence.
  if (row.outcome === 'denied_by_robots') return 'unknown';
  if (row.present === true) return row.soft_404 === true ? 'present-but-soft-404' : 'present';
  if (row.present === false) return 'absent';
  return 'unknown';
}

function doorFromRow(row, dialectClasses) {
  const robots = row.robots ?? {};
  const known = robots.known === true;
  const declared = !known ? 'unreadable' : robots.allowed === false ? 'disallow' : 'allow';

  let evidence;
  if (row.requested === true) evidence = 'behaviour';
  else if (known) evidence = 'robots-declaration';
  else evidence = 'not-attempted';

  return {
    dialect: row.dialect,
    dialect_class: dialectClasses[row.dialect] ?? 'unrecorded',
    evidence,
    // Non-null only for `behaviour`. A denial is a thing WE did, and reporting
    // it here would make our own compliance look like the site's answer.
    last_outcome: row.requested === true ? (row.outcome ?? null) : null,
    http_status: row.status ?? null,
    challenge: row.challenge ?? null,
    robots: {
      declared,
      // Why the policy is unreadable, when it is. `robots-policy-unknown-http-301`
      // is a very different thing to tell an agent than "the site said no".
      reason: robots.reason ?? null,
      rule: robots.rule ?? null,
      // A group written for this token specifically, rather than a `*` catch-all.
      explicit_group: robots.explicit === true,
    },
  };
}

function tollFromRows(rows) {
  const names = new Set();
  let status402 = false;
  for (const r of rows) {
    if (!r.toll) continue;
    if (r.toll.status_402) status402 = true;
    const v = r.toll.header_names ?? r.toll.headers;
    if (Array.isArray(v)) for (const h of v) names.add(h);
  }
  if (!status402 && names.size === 0) return null;
  return { status_402_observed: status402, header_names: [...names].sort() };
}

/**
 * Index a verified capture, and optionally a resolved crowd ledger, into the
 * shape the lookup answers from.
 *
 * `manifest` and `rows` are what `loadVerifiedCapture` returns, so the bytes
 * behind every answer have already been proven to be the published bytes.
 * `resolution` is `resolve()` output from tools/reports.mjs; its state machine
 * owns the corroborated/contested/quarantined distinction and this module only
 * reads the verdict.
 */
export function buildIndex({ manifest, rows, resolution = null, dialectClasses }) {
  if (!manifest?.capture_id) throw new Error('index requires a manifest with a capture_id');
  if (!dialectClasses) throw new Error('index requires the dialect->class map');

  const byDomain = new Map();
  for (const row of rows) {
    if (!row?.domain) continue;
    if (!byDomain.has(row.domain)) byDomain.set(row.domain, { requests: [], files: [] });
    const entry = byDomain.get(row.domain);
    if (row.kind === 'request') entry.requests.push(row);
    else if (row.kind === 'file') entry.files.push(row);
  }

  const claimsByDomain = new Map();
  for (const claim of resolution?.claims ?? []) {
    if (!claimsByDomain.has(claim.domain)) claimsByDomain.set(claim.domain, []);
    claimsByDomain.get(claim.domain).push(claim);
  }

  return {
    manifest,
    dialectClasses,
    byDomain,
    claimsByDomain,
    resolved_at: resolution?.resolved_at ?? null,
    domains: byDomain.size,
  };
}

function provenance(index, now) {
  const m = index.manifest;
  const observedAt = m.observed_through ?? m.observed_from ?? null;
  const ageMinutes = observedAt ? Math.round((Date.parse(now) - Date.parse(observedAt)) / 60_000) : null;
  return {
    capture_id: m.capture_id,
    // Nominal and date-free, exactly as the manifest publishes it. `unrecorded`
    // is a real value here and means the capture has no repeatable slot — it
    // never equals another capture's slot, including another `unrecorded`.
    observation_slot: m.observation_window?.slot ?? 'unrecorded',
    slot_drift_minutes: m.observation_window?.drift_minutes ?? null,
    vantage_class: m.vantage?.class ?? 'unrecorded',
    instrument_profile_version: m.instrument_policy?.profile_version ?? null,
    dataset_sha256: m.dataset?.sha256 ?? null,
    observed_at: observedAt,
    age_minutes: ageMinutes,
    // Two states from one imported constant, not three from a number invented
    // here. Past the bound, this project has already ruled that two observations
    // of a door are not about the same conditions.
    freshness: ageMinutes !== null && ageMinutes <= PROBE_MATCH_MAX_LAG_MINUTES ? 'fresh' : 'stale',
    freshness_bound_minutes: PROBE_MATCH_MAX_LAG_MINUTES,
  };
}

const NEVER_PROBED_LIMITS = [
  'This host has never been probed by canireach. No answer is inferred from its parent domain, its neighbours, or its TLD.',
];

/**
 * Answer one door question.
 *
 * `now` is required rather than defaulted to the wall clock, for the same reason
 * `resolve()` requires it: an answer whose age depends on when it happened to be
 * computed is not reproducible, and every number this project publishes has to
 * be recomputable by a stranger.
 */
export function lookup(index, domainInput, { now }) {
  if (!now) throw new Error('lookup() requires an explicit `now`');
  const domain = normalizeDomain(domainInput);
  const as_of = provenance(index, now);
  const entry = index.byDomain.get(domain);

  if (!entry) {
    return assertNoPresentTenseField({
      domain,
      answer: 'unknown',
      reason: 'never-probed',
      as_of,
      doors: [],
      detour: null,
      crowd: crowdBlock(index, domain),
      limits: NEVER_PROBED_LIMITS,
    });
  }

  const doors = entry.requests
    .map((r) => doorFromRow(r, index.dialectClasses))
    .sort((a, b) => a.dialect.localeCompare(b.dialect));

  const affordances = {};
  for (const f of SITE_FILES) {
    if (f.id === 'robots') continue;
    affordances[f.id] = affordanceState(entry.files.find((r) => r.file === f.id));
  }
  const robotsRow = entry.files.find((r) => r.file === 'robots');

  const limits = [];
  const knocked = doors.filter((d) => d.evidence === 'behaviour').length;
  if (knocked === 0) {
    limits.push(
      'No request was sent to this host at any identity, so nothing here is evidence of what its server would do.',
    );
  }
  if (doors.some((d) => d.evidence === 'not-attempted')) {
    limits.push(
      "Doors marked `not-attempted` were skipped because this host's robots.txt could not be read and this instrument fails closed. That is a fact about the instrument, not about the host.",
    );
  }
  if (as_of.freshness === 'stale') {
    limits.push(
      `This measurement is ${as_of.age_minutes} minutes old, past the ${PROBE_MATCH_MAX_LAG_MINUTES}-minute bound at which this project treats two observations of a door as no longer about the same conditions.`,
    );
  }
  limits.push(
    'Vendor-token doors (gptbot, claudebot) are disclosed simulations carrying a "not the named vendor" notice, never authenticated vendor traffic.',
  );

  return assertNoPresentTenseField({
    domain,
    answer: 'measured',
    as_of,
    doors,
    detour: {
      affordances,
      robots_txt: robotsRow
        ? { http_status: robotsRow.status ?? null, redirected: robotsRow.redirected === true }
        : null,
      toll: tollFromRows(entry.requests),
    },
    crowd: crowdBlock(index, domain),
    limits,
  });
}

/**
 * Crowd claims for a domain.
 *
 * Only `corroborated` claims are served. `contested` and `quarantined` are
 * reported as COUNTS beside them and never merged in — the counts are published
 * apart and never added, which is the same rule the report resolver publishes
 * its four numbers under. A contested door is two promoted claims disagreeing;
 * serving either would be publishing a coin flip.
 */
export function crowdBlock(index, domain) {
  const claims = index.claimsByDomain.get(domain) ?? [];
  return {
    resolved_at: index.resolved_at,
    corroborated: claims
      .filter((c) => c.state === 'corroborated')
      .map((c) => ({
        dialect_class: c.dialect_class,
        last_outcome: c.outcome,
        observation_window: c.window,
        promotion_reasons: c.promotion_reasons,
        distinct_verified_identities: c.distinct_verified_identities,
      }))
      .sort((a, b) => `${a.dialect_class}|${a.observation_window}`.localeCompare(`${b.dialect_class}|${b.observation_window}`)),
    contested_claims: claims.filter((c) => c.state === 'contested').length,
    quarantined_claims: claims.filter((c) => c.state === 'quarantined').length,
    expired_claims: claims.filter((c) => c.state === 'expired').length,
    note: 'Only corroborated claims are served. Contested and quarantined claims are counted, never reported as fact, and never added to the corroborated count.',
  };
}

/**
 * What the caller needs before trusting any answer above: which capture is
 * loaded, how old it is, and how much of it is actually behavioural evidence.
 *
 * The coverage numbers are the honest headline of the whole dataset, and they
 * are derived from the indexed rows rather than read from a manifest field, so
 * they cannot drift from what the lookups above will actually say.
 */
export function datasetStatus(index, { now }) {
  if (!now) throw new Error('datasetStatus() requires an explicit `now`');
  const coverage = { behaviour: 0, 'robots-declaration': 0, 'not-attempted': 0 };
  let domainsWithBehaviour = 0;
  for (const entry of index.byDomain.values()) {
    let any = false;
    for (const row of entry.requests) {
      const kind =
        row.requested === true ? 'behaviour' : row.robots?.known === true ? 'robots-declaration' : 'not-attempted';
      coverage[kind]++;
      if (kind === 'behaviour') any = true;
    }
    if (any) domainsWithBehaviour++;
  }
  return {
    as_of: provenance(index, now),
    domains_indexed: index.byDomain.size,
    domains_with_any_behavioural_evidence: domainsWithBehaviour,
    doors_by_evidence: coverage,
    crowd_resolved_at: index.resolved_at,
    note: 'Doors counted as `not-attempted` were skipped because robots.txt was unreadable and this instrument fails closed. They are evidence about the instrument, not about the hosts.',
  };
}
