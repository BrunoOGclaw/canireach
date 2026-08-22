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

Requests use modest concurrency, a per-domain delay, and a 12-second timeout.

**The probe target and `robots.txt` get different redirect policies, and the
difference is deliberate.** For the probe target, a redirect is recorded by
status, destination host, scheme, and whether it crosses origins, and is never
followed: the destination path has not received its own robots verdict, and a
redirect is an observation rather than permission to make another request. This
is a status probe, not a crawler.

`robots.txt` is not a destination — it is the policy document, and RFC 9309
§2.3.1.2 addresses its redirects directly: crawlers SHOULD follow at least five
consecutive redirects, even across authorities, and a policy reached within five
MUST be applied in the context of the initial authority. From schema v3 the
probe does exactly that. The full chain is published on the `robots` row
(`redirect_hops`, `redirect_chain`, `final_host`), so which authority actually
answered is auditable from the bytes. Following the policy document is not
following the site: every measured request still goes to the domain on the input
list, under the rules fetched on its behalf.

More than five consecutive redirects, a missing or unparseable `Location`, a
non-HTTP scheme, a loop, or a redirect to a literal loopback/link-local/private
address leaves policy unknown and fails closed exactly like an unreadable
`robots.txt`. The private-address refusal is a guard against a hosted runner
being pointed at its own metadata service by a third party's `Location` header;
it matches address literals only and makes no claim about hostnames that
*resolve* into private space.

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

## Crowd reports and quarantine

Our own probes are ground truth: one vantage, one hour, one thousand domains.
Reports from other agents exist to cover the doors we cannot reach — other
networks, other hours, other identities, authenticated sessions we will never
hold. They are also free to fabricate, so nothing a stranger sends us is data
when it arrives.

Every accepted report enters `quarantined` and stays there until evidence we did
not receive from the reporter promotes it. State is **derived** on every
resolution from the evidence present, never stored and never set by hand, and
`tools/reports.mjs` refuses to resolve without an explicit clock so that any
published resolution is recomputable by a stranger.

**Promotion** requires one of exactly two things:

- an **owned-probe match** — a capture row agreeing on domain, dialect class and
  outcome, observed within 180 minutes of the report. The lag bound is not
  decoration: our capture is one instant per night, and a probe fourteen hours
  away agreeing with a report is a coincidence of the clock. This is the same
  rule the capture-to-capture comparison already enforces, one layer down.
- **multiple independent verified reporters** — at least two distinct Web Bot
  Auth key thumbprints. A self-declared `reporter_id` is worth **zero** toward
  promotion no matter how many agree, because minting a thousand of them costs
  one loop. Unsigned reporters are promotable only by a probe match.

A reputation path, by which a long-lived unsigned reporter with a probe-matched
history earns standing, is deliberately **not built**. Until it exists, the rule
above is the whole rule.

**Contested.** Two promoted claims about the same domain, identity class and
hour with different outcomes demote each other. Publishing either as fact would
be publishing a coin flip.

**Two keys, kept separate.** `submission_key` (reporter + report id) collapses
exact resubmissions; `claim_key` (domain + dialect class + outcome + hour)
groups observations for corroboration. Collapsing them into one "deduplication
key" would turn one reporter pressing retry into a crowd of agreeing observers.

**The counts are never added.** `submissions`, `distinct_submissions`, `claims`,
`corroborated_claims` and `distinct_verified_identities` are separate numbers.
Only corroborated claims are publishable as access data. The agreed kill metric
counts submissions, which is the weakest of them — and quoting it as if it were
the strongest is how a dataset manufactures its own launch.

### Abuse and retention limits

- Reports are retained **90 days** from receipt, then expire.
- An observation more than **7 days** older than its receipt is retained but
  cannot corroborate: by then neither our probes nor another reporter can speak
  to that moment.
- `observed_at` is chosen by the reporter and `received_at` by us; both are
  stored. An observation dated more than 5 minutes into the future relative to
  receipt is rejected, so a reporter cannot place an observation inside a
  capture window on purpose to manufacture a match.
- Per-identity ceilings, per rolling day: 5,000 verified, 500 self-declared,
  50 anonymous.
- The envelope is a strict **allowlist**; an unknown field is a rejection, not a
  strip. Reports carry no page content, headers, cookies, IP addresses, URLs
  beyond a bare hostname, or personal data. The allowlist itself is guarded, so
  widening it to a forbidden field fails the build.
- There is **no ingest endpoint yet**, and no unauthenticated public write
  surface is authorised. This is the schema and the state machine only.

## Answering an agent: what a lookup may and may not say

`tools/lookup.mjs` derives every answer from a capture whose bytes hashed to the
SHA-256 its manifest published, plus crowd claims already promoted by the state
machine above. No hand-maintained table is consulted, and the tool never probes
on demand: a reachability service that fetched on request would be an
on-request scanner pointed at whatever third party the caller named.

**Every door is classified by what we actually did**, not by the row's outcome
string. A request row carries `outcome: denied_by_robots` in two situations that
mean opposite things, and the row's `robots.known` flag separates them:

| Evidence | What happened | What it says about the host |
| --- | --- | --- |
| `behaviour` | Request sent, response observed | The site's actual behaviour toward that identity |
| `robots-declaration` | robots.txt read; it disallows this token | The site's declaration. We obeyed it and never asked, so it is not behaviour |
| `not-attempted` | robots.txt unreadable; this instrument fails closed | **Nothing.** It is a fact about the instrument |

`last_outcome` is non-null only for `behaviour`. Reporting a denial as an
outcome would present our own compliance, and our own fail-closed default, as
the site's answer. On the 2026-08-22T162332Z capture the split is 945
`behaviour`, 100 `robots-declaration`, 3,955 `not-attempted` — so a tool that
collapsed the three would overstate refusals by roughly forty to one.

The same distinction applies one layer over, to the detour: an affordance file
that was never fetched because the robots gate closed is reported `unknown`,
never `absent`.

**Age is part of the answer, not a footnote.** Captures are one instant per
night and reachability is not hour-invariant, which is why the observation hour
is a comparability dimension. Every answer carries its capture id, observation
slot, vantage class, `observed_at`, `age_minutes`, and a `freshness` verdict
against `PROBE_MATCH_MAX_LAG_MINUTES` — the same 180-minute bound used to decide
whether an owned probe may corroborate a crowd report, imported rather than
restated. No field in an answer is present-tense: there is no `reachable`, no
`blocked`, no `allowed`, and a guard on the rendered answer refuses one.

A host that has never been probed answers `unknown`. There is no parent-domain
fallback and no inference from neighbouring hosts.

## Input provenance

`data/domains/tranco-74V8X-1000.csv` contains ranks 1-1000 from Tranco list
`74V8X`, captured 2026-08-22. Tranco rankings are research-oriented aggregates;
the list is a sampling frame, not a claim about exact global popularity.

## Known limits

- One probe location cannot separate IP reputation or geography from identity.
- An explicit 404/410 means no `robots.txt` policy and permits the status probe,
  read from the response the policy was finally fetched from. Auth/challenge
  responses, rate limits, server failures, network errors, and redirects that
  do not resolve to a policy document within five hops leave policy unknown;
  the instrument fails closed and sends no later request.
- Challenge detection is fingerprint-based and can have false positives or
  false negatives.
- A 200 response can be a soft 404. Agent-affordance files apply a conservative
  HTML-shell check, but cannot prove semantic validity.
- Vendor-token simulations are not vendor-authenticated traffic.
- **Most of a capture was not behavioural evidence, and the reason was us.** On
  2026-08-22T162332Z only 195 of 1,000 domains carried any. 452 domains redirect
  `robots.txt` — 374 of them to their own `www.` host — and the instrument
  recorded those redirects without following them, so its fail-closed policy
  stopped those doors before a request was sent. That was a conformance gap
  against RFC 9309 §2.3.1.2, not a judgement call, and it is fixed from schema
  v3 (see *Robots and access controls*). **Captures before and after that change
  are not strictly comparable**: `instrument_policy.robots_redirects` is a
  declared dimension, an older manifest reports it as `unrecorded`, and
  `unrecorded` never equals anything — so `tools/compare.mjs` withholds across
  the boundary. That is the gate working. The change landed before the first
  scheduled capture, so the automated 04:17 series is uniform from its first
  night; only the v1 baseline and the hand-run daytime captures sit on the far
  side, and none of those could pair with the series in any case.
