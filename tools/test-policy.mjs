#!/usr/bin/env node
//
// The declared comparability profile is DERIVED BACK OUT of the running
// instrument here and compared to tools/policy.mjs. Nothing in this file trusts
// the declaration; every value is observed by driving probeDomain/probeUrl with
// stub responses and reading what the instrument actually did.
//
// That direction matters. A profile recorded into every release is a claim that
// two nights are comparable, so a profile that drifts from the code is a
// confounder disguised as a control — strictly worse than recording nothing.
// Flip the code without flipping the declaration, or the reverse, and this test
// goes red either way.

import assert from 'node:assert/strict';
import { DIALECTS } from './dialects.mjs';
import { INSTRUMENT_POLICY, COMPARABILITY_DIMENSIONS, dimensionValue, dimensionsAgree, UNRECORDED } from './policy.mjs';
import { probeDomain, probeUrl, fetchRobots } from './probe.mjs';

const noSleep = async () => {};
const ok = (status, extra = {}) => ({ ok: true, status, headers: {}, body: '', bytes_read: 0, elapsed_ms: 1, final_url: 'https://example.com/', ...extra });

/** Drive one domain with a chosen robots.txt response and report what happened. */
async function runWithRobots(robotsResponse) {
  const requested = [];
  const probeUrlImpl = async (url) => {
    if (url.endsWith('/robots.txt')) return robotsResponse;
    requested.push(url);
    return ok(200);
  };
  const rows = await probeDomain(1, 'example.com', { probeUrlImpl, sleepImpl: noSleep });
  return { rows, requested };
}

// --- observe: what does an unreadable robots.txt do? ------------------------

const unreadable = [
  ['http-500', ok(500)],
  ['http-403', ok(403)],
  ['http-302', ok(302)],
  ['network-error', { ok: false, error: 'conn_reset', error_detail: 'ECONNRESET', elapsed_ms: 1 }],
];

let failsClosed = true;
for (const [label, response] of unreadable) {
  const { rows, requested } = await runWithRobots(response);
  const sent = rows.filter((r) => r.kind === 'request' && r.requested).length;
  if (sent > 0 || requested.length > 0) {
    failsClosed = false;
    console.error(`  observed: ${label} still sent ${requested.length} request(s)`);
  }
}

// 404/410 are the narrow published exception: RFC 9309 treats an explicitly
// absent robots.txt as permission, and the instrument uses only that signal.
let allowsAbsent = true;
for (const [label, response] of [['http-404', ok(404)], ['http-410', ok(410)]]) {
  const { rows } = await runWithRobots(response);
  const sent = rows.filter((r) => r.kind === 'request' && r.requested).length;
  if (sent !== DIALECTS.length) {
    allowsAbsent = false;
    console.error(`  observed: ${label} sent ${sent} of ${DIALECTS.length} dialect requests`);
  }
}

const observedRobotsUnavailable = failsClosed
  ? allowsAbsent
    ? 'fail-closed-except-404-410'
    : 'fail-closed'
  : 'fail-open';

assert.equal(
  INSTRUMENT_POLICY.robots_unavailable,
  observedRobotsUnavailable,
  `declared robots_unavailable=${INSTRUMENT_POLICY.robots_unavailable} but the instrument behaves as ${observedRobotsUnavailable}`,
);

// --- observe: is a denial actually a gate on sending? -----------------------

{
  const denyAll = ok(200, { body: 'User-agent: *\nDisallow: /\n' });
  const { rows, requested } = await runWithRobots(denyAll);
  const sent = rows.filter((r) => r.kind === 'request' && r.requested).length;
  const observed = sent === 0 && requested.length === 0 ? 'no-request-past-a-denial' : 'requests-sent-past-a-denial';
  assert.equal(INSTRUMENT_POLICY.denial_gate, observed, `declared denial_gate does not match observed ${observed}`);
  assert.ok(
    rows.some((r) => r.outcome === 'denied_by_robots'),
    'a full disallow must still produce rows: a denial is data, not an absence',
  );
}

// --- observe: are redirects followed? ---------------------------------------
//
// There are TWO redirect policies and they deliberately differ, so both are
// derived separately. A single declaration covering both would let a change to
// one of them hide behind the other.

{
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response('', { status: 301, headers: { location: 'https://elsewhere.example/' } });
  };
  const res = await probeUrl('https://example.com/', 'TestAgent/1', { fetchImpl });
  const observed =
    calls === 1 && res.redirect?.target_host === 'elsewhere.example'
      ? 'probe-target-recorded-never-followed'
      : calls > 1
        ? 'probe-target-followed'
        : 'unrecorded';
  assert.equal(INSTRUMENT_POLICY.redirects, observed, `declared redirects does not match observed ${observed}`);
}

{
  // How many consecutive robots.txt redirects does the instrument actually
  // follow, and does it cross authorities? Counted by handing it an endless
  // cross-host chain and reading the requests it made, not by reading the
  // constant beside the loop.
  const seen = [];
  const endless = async (url) => {
    seen.push(url);
    const at = url === 'https://example.com/robots.txt' ? 0 : Number(/h(\d+)\./.exec(url)[1]);
    return {
      ok: true,
      status: 301,
      headers: { location: `https://h${at + 1}.example.com/robots.txt` },
      body: '',
      bytes_read: 0,
      elapsed_ms: 1,
      final_url: url,
      redirect: null,
    };
  };
  const out = await fetchRobots('example.com', 'TestAgent/1', { probeUrlImpl: endless, sleepImpl: noSleep });
  const followed = seen.length - 1;
  const crossed = seen.some((url) => !url.startsWith('https://example.com/'));
  const observed =
    followed === 0
      ? 'recorded-never-followed'
      : `followed-max-${followed}${crossed ? '-cross-authority' : '-same-authority'}`;
  assert.equal(
    INSTRUMENT_POLICY.robots_redirects,
    observed,
    `declared robots_redirects does not match observed ${observed}`,
  );
  assert.equal(out.refusal, 'redirect-exhausted', 'an endless chain must terminate as unavailable, not spin');
  assert.ok(
    COMPARABILITY_DIMENSIONS.includes('instrument_policy.robots_redirects'),
    'following robots redirects changed the instrument; a capture from before it must not compare equal',
  );
}

// --- the derived fields must actually be derived ----------------------------

assert.deepEqual(INSTRUMENT_POLICY.dialects, DIALECTS.map((d) => d.id).sort());
assert.ok(INSTRUMENT_POLICY.dialects.length >= 5, 'dialect list looks truncated');

{
  // probe.mjs now imports ROW_SCHEMA_VERSION rather than repeating the literal,
  // so the declaration and the rows CANNOT drift — a guarantee is better than a
  // test for the same property, and an equality check between two reads of one
  // constant would be theatre. What keeps the number honest instead is
  // tools/test-run-artifact.mjs, which proves the validator refuses a capture at
  // any other schema. Asserted here only so the rows are observed at all.
  const [row] = await runWithRobots(ok(200, { body: '' })).then((r) => r.rows);
  assert.equal(row.schema_version, INSTRUMENT_POLICY.row_schema_version);
}

// --- the unrecorded rule, which is what protects the pre-automation baseline --

assert.equal(dimensionValue({ vantage: {} }, 'vantage.class'), UNRECORDED);
assert.equal(dimensionValue({}, 'instrument_policy.redirects'), UNRECORDED);
assert.equal(
  dimensionsAgree(UNRECORDED, UNRECORDED),
  false,
  'two captures with unrecorded policy must not be treated as agreeing',
);
assert.equal(dimensionsAgree(['a', 'b'], ['a', 'b']), true, 'list dimensions must compare by value');
assert.ok(COMPARABILITY_DIMENSIONS.includes('vantage.class'));
assert.ok(COMPARABILITY_DIMENSIONS.includes('instrument_policy.robots_unavailable'));

console.log(
  `instrument policy verified against behaviour: robots_unavailable=${observedRobotsUnavailable}, ` +
    `denial_gate, redirects, schema and dialects all derived from the running probe`,
);
