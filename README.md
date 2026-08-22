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
node tools/probe.mjs --limit 10 --concurrency 2
```

The committed input is the top 1,000 domains from Tranco list `74V8X`, fetched
2026-08-22. Results are append-only JSONL with one row per observed file or
domain/dialect request. Derived summaries must be rebuilt from those rows; they
are never hand-maintained.

See [METHODOLOGY.md](METHODOLOGY.md) for the measurement and safety contract.

## Status

Early baseline instrument. Crowd reports, the MCP tool, and the public map come
after the owned probe data is flowing.
