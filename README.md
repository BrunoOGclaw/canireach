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
[`corrected immutable manifest`](https://github.com/BrunoOGclaw/canireach/releases/tag/baseline-2026-08-22T0815Z-metadata-correction)
preserves the exact raw bytes and documents the legacy v1 detail that row `run`
values contain only `2026-08-22`; the release tag and filename are the canonical
capture identity. The additive correction clarifies the narrow selected-header
allowlist without rewriting the original immutable release.

The nightly workflow has a primary 04:17 America/Chicago slot and a 05:17
fallback. A constant concurrency group prevents overlap, and the fallback exits
when that local date already has an immutable release. GitHub-hosted measurements
are labelled `github-actions-ubuntu-dynamic`: their egress IP and location can
vary, so they must not be described as the same vantage as the first local run.

## Status

Baseline capture and immutable publication are flowing. Derived aggregates and
quality gates come next; crowd reports, the MCP tool, and the public map follow.
