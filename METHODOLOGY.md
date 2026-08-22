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
`server`, `x_robots_tag`, `content_type`, the presence (not value) of `cf-ray`,
and toll-related header names. Header names are not header values and cannot
carry credentials.

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

## Comparability between captures

The claim this dataset exists to support is a difference between two dates. A
difference only describes the web if the instrument held still, so each release
manifest records the instrument's comparability profile alongside its vantage,
and `tools/compare.mjs` refuses to emit a delta between two captures that
disagree on any of these dimensions:

`vantage.class`, `observation_window.slot`, `input.sha256`, and the instrument's
row schema version, robots-unavailable policy, redirect policy, denial gate, and
dialect set.

`observation_window.slot` is the repeatable local slot a capture was taken in —
`04:17[America/Chicago]` — and it is on the list because everything else on it
describes how the instrument was *configured* and none of it described *when it
looked*. The first two captures of the automated series agreed on every other
dimension and were taken fourteen hours apart, at 09:45 and 04:17 local; the
gate reported them strictly comparable with zero confounders. Rate limits,
challenge rates and CDN behaviour are not hour-invariant, so a delta across that
pairing would have described the time of day.

The slot is nominal, not observed: a run that fires in the 05:17 fallback is
still satisfying the 04:17 slot, so schedule slip does not fragment the series.
The slip is published beside the slot as `drift_minutes` rather than folded into
it, because an hour of slip that silently reshaped a comparability dimension
would be a confounder reading as a control. A hand-dispatched capture has no
repeatable slot and is `unrecorded`, so it can never be differenced against a
nightly one — including against another manual capture.

A dimension that a manifest does not record reads as `unrecorded`, and
`unrecorded` never equals anything — including another `unrecorded`. Two
captures whose policy nobody wrote down are not thereby known to share one.

A differing dimension can be acknowledged explicitly (`--acknowledge
vantage.class`), which releases the delta and attaches that dimension to the
output as a named confounder. Acknowledgement is not a bypass: the confounder
travels with the numbers, so a delta computed across a vantage change cannot be
quoted without the vantage change quoted with it.

**There is one such discontinuity already in the record, and it is the most
important caveat on this dataset.** The first baseline,
`2026-08-22T0815Z`, was captured from a residential host, with an unreadable
`robots.txt` failing **open**. Every capture in the automated nightly series
runs from GitHub-hosted dynamic egress, with an unreadable `robots.txt` failing
**closed**. Each change moves the headline numbers on its own, and both move
them in the direction that looks like "the web got harder" — which is precisely
the claim the September 15 comparison is meant to test. Fail-closed is the
correct behaviour and stays; the discontinuity is handled by declaring it, not
by reverting it.

The profile is declared in `tools/policy.mjs` and derived back out of the
running probe by `tools/test-policy.mjs`. A declaration that drifts from the
code it describes is worse than no declaration: it is a confounder that reads
as a control.

The manifest also carries the derived aggregates, and the publication gate
recomputes them from the same bytes it is about to publish. No number on a
release is hand-maintained.

### Reading a manifest that predates the aggregates block

The first baseline is schema v1: it was published before manifests carried
aggregates, and it is an immutable release, so it cannot be regenerated in
place. Rather than leave the one capture the September 15 comparison exists for
outside that comparison, `compare.mjs` recomputes a v1 side's aggregates from
the capture's own bytes, and admits them only when

1. the bytes hash to the `dataset.sha256` published in the manifest,
2. the row count matches the one the manifest declares, and
3. the recomputed outcome counts reproduce the `request_outcomes` published
   beside those bytes, exactly.

The third condition is the one that matters most. The hash proves the bytes are
the published bytes; the crosscheck proves that today's aggregator, reading
them, still gets the numbers that were published on the day. If the counting
rules ever drift, a delta built on a recomputed side would silently be measuring
that drift instead of the web.

Any output whose numbers were regenerated this way says so:
`before.aggregates_source` reads `recomputed-from-verified-bytes` rather than
`published-manifest`. A reader of a delta is entitled to know which side was
recomputed today.

Recomputation does not soften the comparability gate — it is what allows the
gate to be *reached*. The two published captures still refuse to be differenced,
now for the substantive reason rather than a structural one.

## Input provenance

`data/domains/tranco-74V8X-1000.csv` contains ranks 1-1000 from Tranco list
`74V8X`, captured 2026-08-22. Tranco rankings are research-oriented aggregates;
the list is a sampling frame, not a claim about exact global popularity.

## Known limits

- One probe location cannot separate IP reputation or geography from identity.
- An explicit 404/410 means no `robots.txt` policy and permits the status probe.
  Redirects, auth/challenge responses, rate limits, server failures, and network
  errors leave policy unknown; schema v2 fails closed and sends no later request.
- Challenge detection is fingerprint-based and can have false positives or
  false negatives.
- A 200 response can be a soft 404. Agent-affordance files apply a conservative
  HTML-shell check, but cannot prove semantic validity.
- Vendor-token simulations are not vendor-authenticated traffic.
