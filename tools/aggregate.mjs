// Derived aggregates: the numbers the map and the MCP tool answer with.
//
// Everything here is recomputed from the capture's own rows every time. No
// aggregate is ever hand-maintained or carried forward — a hand-written summary
// of a growing dataset drifts away from the data, and the correction history of
// the first baseline release is what that costs.
//
// SCHEMA v1 AND v2 ARE BOTH READ, DELIBERATELY. The first pre-September-15
// capture is published as immutable v1 bytes and can never be rewritten, so an
// aggregator that only understands v2 could not read the one capture the whole
// project exists to compare against. Where the schemas differ, the difference is
// handled explicitly and named, never smoothed over.
//
// Usage: node tools/aggregate.mjs <capture.jsonl> [--out FILE]

import { readFileSync, writeFileSync } from 'node:fs';
import { SITE_FILES } from './dialects.mjs';

const bump = (o, k) => {
  o[k] = (o[k] || 0) + 1;
};

/**
 * Toll header names. v2 calls this `header_names`; v1 called it `headers`. The
 * values were always header NAMES in both, so this is a rename, not a change of
 * meaning — which is exactly why it is worth reading both rather than dropping
 * the older capture on the floor.
 */
function tollNames(toll) {
  const v = toll.header_names ?? toll.headers;
  return Array.isArray(v) ? v : [];
}

export function aggregate(rows) {
  const requestRows = rows.filter((r) => r.kind === 'request');
  const fileRows = rows.filter((r) => r.kind === 'file');

  const outcomes = {};
  const byDialect = {};
  const challenges = {};
  const toll = {};
  const robotsPolicy = {};
  const servers = {};
  let redirected = 0;
  let redirectCrossOrigin = 0;

  for (const r of requestRows) {
    bump(outcomes, r.outcome);

    byDialect[r.dialect] ||= { attempted: 0, sent: 0, outcomes: {} };
    const d = byDialect[r.dialect];
    d.attempted++;
    if (r.requested) d.sent++;
    bump(d.outcomes, r.outcome);

    // The policy layer, kept separate from the behaviour layer. "Denied" here is
    // a declaration we obeyed; it is not evidence about what the site would have
    // done, and the two must never be added together.
    robotsPolicy[r.dialect] ||= { allowed: 0, denied: 0, unknown: 0 };
    if (!r.robots) robotsPolicy[r.dialect].unknown++;
    else if (r.robots.allowed) robotsPolicy[r.dialect].allowed++;
    else if (String(r.robots.reason || '').includes('policy-unknown')) robotsPolicy[r.dialect].unknown++;
    else robotsPolicy[r.dialect].denied++;

    if (r.challenge) bump(challenges, r.challenge);
    if (r.toll) {
      if (r.toll.status_402) bump(toll, 'status_402');
      for (const h of tollNames(r.toll)) bump(toll, h);
    }
    if (r.server) bump(servers, String(r.server).split('/')[0].toLowerCase());
    if (r.redirected) redirected++;
    if (r.redirect_cross_origin) redirectCrossOrigin++;
  }

  // Agent-affordance adoption: the other half of the thesis. A site publishing
  // llms.txt or agents.md is drawing the detour for us instead of just saying no.
  const affordances = {};
  for (const f of SITE_FILES) {
    if (f.id === 'robots') continue;
    const forFile = fileRows.filter((r) => r.file === f.id);
    affordances[f.id] = {
      checked: forFile.length,
      present: forFile.filter((r) => r.present === true).length,
      // A 200 that is really an SPA shell. Counted, not discarded: a site that
      // answers 200 to every unknown path is itself hostile to agents.
      soft_404: forFile.filter((r) => r.soft_404 === true).length,
      not_checked: forFile.filter((r) => r.outcome === 'denied_by_robots').length,
    };
  }

  const robotsRows = fileRows.filter((r) => r.file === 'robots');
  const sent = requestRows.filter((r) => r.requested).length;

  return {
    schema_versions: [...new Set(rows.map((r) => r.schema_version ?? 1))].sort(),
    rows: rows.length,
    domains: new Set(rows.map((r) => r.domain)).size,
    vantages: [...new Set(rows.map((r) => r.vantage ?? 'unrecorded'))],
    request_rows: requestRows.length,
    file_rows: fileRows.length,
    requests_sent: sent,
    // Denominator discipline: the headline rate is over requests actually SENT.
    // Dividing reachable by all request rows would silently count robots denials
    // as unreachability and turn our own compliance into the web's hostility.
    reachable_rate_of_sent: sent ? Number(((outcomes.reachable || 0) / sent).toFixed(4)) : null,
    outcomes,
    by_dialect: byDialect,
    robots_policy: robotsPolicy,
    robots_txt: {
      served_200: robotsRows.filter((r) => r.status === 200).length,
      absent_or_error: robotsRows.filter((r) => r.status !== 200).length,
    },
    redirects: { observed: redirected, cross_origin: redirectCrossOrigin },
    affordances,
    challenges,
    toll,
    top_servers: Object.fromEntries(
      Object.entries(servers)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12),
    ),
  };
}

export function aggregateFile(path) {
  const rows = readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  return aggregate(rows);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const oi = args.indexOf('--out');
  const out = oi >= 0 ? args[oi + 1] : null;
  const file = args.find((a) => !a.startsWith('--') && a !== out);
  if (!file) {
    console.error('usage: node tools/aggregate.mjs <capture.jsonl> [--out FILE]');
    process.exit(2);
  }
  const json = JSON.stringify(aggregateFile(file), null, 2);
  if (out) {
    writeFileSync(out, json + '\n');
    console.error(`aggregates -> ${out}`);
  } else {
    console.log(json);
  }
}
