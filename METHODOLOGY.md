# Methodology and safety contract

## What is measured

For each domain and dialect, v1 records:

- the applicable `robots.txt` verdict;
- HTTP status, redirect count, response time, and final host;
- known challenge/interstitial markers and HTTP 402/toll signals;
- presence of `llms.txt`, `agents.md`, `/.well-known/agents.md`, and Web Bot
  Auth directory signals.

Responses are capped at 12 KiB in memory for fingerprinting and discarded.
The dataset stores no response body, cookies, presented user-agent strings, or
general response-header map. It does retain a narrow metadata allowlist:
`server`, `x_robots_tag`, the presence (not value) of `cf-ray`, and toll-related
header names. Header names are not header values and cannot carry credentials.

## Identity

The important measurement identity is `CanIReachBot`, which self-identifies and
links to the project. Browser and curl are controls. GPTBot and ClaudeBot rows
measure treatment of published product tokens, but append an explicit statement
that this probe is not the named vendor. These rows are experimental simulations,
not authentic vendor traffic, and must never be described otherwise.

This choice prevents quiet impersonation but may itself change a site's result.
That limitation is part of the data.

## Robots and access controls

The probe fetches `robots.txt` with its own identity. For every later request it
computes the policy for the identity being presented. If the path is denied, it
records the denial and sends no request. It does not solve CAPTCHAs, evade
challenges, rotate identities, log in, or scrape content.

Requests use modest concurrency, a per-domain delay, and a 12-second timeout. A
redirect is recorded by status, destination host, scheme, and whether it crosses
origins, but is never followed: the destination path has
not received its own robots verdict, and redirects are observations rather than
permission to make another request. This is a status probe, not a crawler.

## Run identity, vantage, and publication

Schema v2 binds every row to a unique capture id and a declared vantage. A run
writes only to a new `.partial` file, refuses an existing id or final filename,
checks the exact expected row/request cardinality, fsyncs, and atomically renames
to JSONL. The publication gate then checks every row against the pinned input
list, robots invariants, schema, identity, output privacy allowlist, duplicate
identities, and credential-shaped values.

Nightly runs execute from a GitHub-hosted Ubuntu runner with dynamic egress and
say so in every row and manifest. That is a different vantage class from the
first local capture; comparisons must retain the vantage dimension. Successful
runs are published as immutable GitHub Releases with the raw JSONL, a manifest,
and SHA-256 checksum. A transient Actions artifact only moves validated bytes
between the unprivileged probe job and the narrowly write-enabled publisher job.

## Input provenance

`data/domains/tranco-74V8X-1000.csv` contains ranks 1-1000 from Tranco list
`74V8X`, captured 2026-08-22. Tranco rankings are research-oriented aggregates;
the list is a sampling frame, not a claim about exact global popularity.

## Known limits

- One probe location cannot separate IP reputation or geography from identity.
- A missing or unavailable `robots.txt` makes policy unknown; v1 proceeds with
  the status probe and labels that uncertainty.
- Challenge detection is fingerprint-based and can have false positives or
  false negatives.
- A 200 response can be a soft 404. Agent-affordance files apply a conservative
  HTML-shell check, but cannot prove semantic validity.
- Vendor-token simulations are not vendor-authenticated traffic.
