# Can I Reach?

A behavioral access map for the agent web. The baseline probe asks a narrow
question: can an agent reach a domain through the front door, and if not, what
happened?

The project is capturing a pre-September 15, 2026 baseline before Cloudflare's
new default crawler policy takes effect. It records policy and response
metadata, not page content.

## Probe v1

Requirements: Node.js 20 or newer. There are no package dependencies.

```sh
node tools/test-robots.mjs
node tools/mutate-robots.mjs
node tools/test-probe.mjs
node tools/test-run-artifact.mjs
node tools/test-aggregate.mjs
node tools/probe.mjs --limit 10 --concurrency 2 --run 2026-08-22-smoke --vantage local-smoke
```

The committed input is the top 1,000 domains from Tranco list `74V8X`, fetched
2026-08-22. Results are append-only JSONL with one row per observed file or
domain/dialect request. Derived summaries must be rebuilt from those rows; they
are never hand-maintained.

See [METHODOLOGY.md](METHODOLOGY.md) for the measurement and safety contract.

## Published data

Every complete capture is validated, hashed, and published as a GitHub Release
with its raw JSONL, machine-readable manifest, and checksum. Release immutability
locks the tag and assets after publication. Raw captures do not live in Git
history and workflow artifacts are only a one-day handoff, never durable storage.

The first pre-September 15 capture is 10,000 rows across 1,000 domains. Its
[`final corrected immutable manifest`](https://github.com/BrunoOGclaw/canireach/releases/tag/baseline-2026-08-22T0815Z-metadata-correction-v2)
preserves the exact raw bytes and documents the legacy v1 detail that row `run`
values contain only `2026-08-22`; the release tag and filename are the canonical
capture identity. The additive corrections exhaustively disclose the narrow
selected-header allowlist without rewriting either prior immutable release.

The nightly workflow has a primary 04:17 America/Chicago slot and a 05:17
fallback. A constant concurrency group prevents overlap, and the fallback exits
when that local date already has an immutable release. GitHub-hosted measurements
are labelled `github-actions-ubuntu-dynamic`: their egress IP and location can
vary, so they must not be described as the same vantage as the first local run.

## The agent-facing MCP tool

An agent in its own loop can ask what we last measured at a door. The server
speaks JSON-RPC over stdio, has no dependencies, and reads only a published
capture whose bytes hash to the SHA-256 its manifest declares.

```sh
gh release download baseline-2026-08-22T162332Z-manual-gh32584556102a1 -D /tmp/cir
node tools/mcp-server.mjs --manifest /tmp/cir/*.manifest.json
```

Two tools: `reachability_lookup` (one domain) and `dataset_status` (which
capture is loaded, how old it is, how much of it is behavioural evidence).

**It is read-only and it never probes on demand.** A reachability tool that
fetched on request would be an on-request scanner aimed at whatever third party
the caller named. `tools/test-lookup.mjs` asserts on the source that neither
`lookup.mjs` nor `mcp-server.mjs` calls `fetch`, imports the prober, opens a
socket or a process, or writes to disk.

Three things the answers refuse to do, because each is how a lookup tool becomes
confidently wrong:

- **No field is present-tense.** There is no `reachable`, no `blocked`, no
  `allowed`. Behaviour is `last_outcome` and travels welded to `observed_at`,
  `age_minutes` and a `freshness` verdict against the 180-minute bound this
  project already uses to decide when two observations stop being about the same
  conditions. Our capture is one instant per night; the caller's question is
  about now, and the envelope never lets those be confused.
- **A door we did not knock on has no answer.** `last_outcome` is non-null only
  where a request was actually sent. Doors are `behaviour`, `robots-declaration`
  (robots.txt was read and says no) or `not-attempted` (robots.txt was
  unreadable and this instrument fails closed — a fact about us, not the host).
  On the 2026-08-22T162332Z capture that split is **945 / 100 / 3,955**: flatten
  it and the tool would report 4,055 closed doors where only 100 are the site
  actually saying no.
- **An unprobed host is `unknown`.** No parent-domain fallback, no inference from
  neighbours. `api.example.com` is not `example.com`.

Crowd claims appear only once `tools/reports.mjs` has promoted them to
`corroborated`. Contested and quarantined claims are counted beside them, never
served as fact, and never added into the corroborated count.

## Status

Baseline capture and immutable publication are flowing, and derived aggregates
are computed from the published bytes (`node tools/aggregate.mjs <capture.jsonl>`,
reading both schema v1 and v2 so the immutable first baseline stays comparable).
The crowd-report envelope and quarantine state machine exist
(`tools/reports.mjs`); nothing a stranger sends becomes data until an owned
probe matches it or two independently keyed reporters agree, and there is no
ingest endpoint yet. See METHODOLOGY.md for the promotion rules and the abuse
and retention limits. The agent-facing MCP tool is above. The public map, and
the site pages that document the tool, follow.

Fixed limit, measured rather than estimated: on the 2026-08-22T162332Z capture
only **195 of 1,000 domains** carried any behavioural evidence at all. 452
domains redirect their `robots.txt` — 374 to their own `www.` host — and the
instrument recorded those redirects without following them, so its fail-closed
policy stopped those doors before a request was sent. RFC 9309 §2.3.1.2 says
crawlers SHOULD follow at least five consecutive redirects for robots.txt, even
across authorities, so that was a conformance gap and not a judgement call.
Schema v3 follows them, applies the policy in the context of the initial
authority, and publishes the chain. The probe target's redirect policy is
unchanged and a test proves it is unchanged, because a change that relaxed both
would be indistinguishable from this one in the aggregates. Captures either side
of the change are not strictly comparable and `tools/compare.mjs` withholds
across the boundary by design.
