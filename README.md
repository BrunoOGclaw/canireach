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
node tools/test-validate.mjs
node tools/probe.mjs --limit 10 --concurrency 2
```

The committed input is the top 1,000 domains from Tranco list `74V8X`, fetched
2026-08-22. Results are append-only JSONL with one row per observed file or
domain/dialect request. Derived summaries must be rebuilt from those rows; they
are never hand-maintained.

## Nightly capture

```sh
tools/capture.sh
```

One night, end to end: probe, gate, manifest, publish as a dated GitHub release,
then re-download and byte-compare what was actually published. It is safe to run
repeatedly — idempotence is checked against the **published release**, not local
disk, because raw captures are gitignored and a local file proves nothing about
whether that night survived off-host.

A capture that fails any gate is kept for diagnosis and **not** published. Exit
codes distinguish already-captured (0) from probe failure (2), gate rejection
(3), publish or verification failure (4), an unpublished local capture in the way
(5), and no usable GitHub seat (6) — a nightly job that exits 0 having done
nothing is the failure this project is about.

Published captures live in [releases](https://github.com/BrunoOGclaw/canireach/releases),
each with the dataset, its SHA-256, and a manifest carrying the derived
aggregates and the gates that capture passed.

See [METHODOLOGY.md](METHODOLOGY.md) for the measurement and safety contract,
including what each gate catches and why vantage is recorded.

## Status

Early baseline instrument. Crowd reports, the MCP tool, and the public map come
after the owned probe data is flowing.
