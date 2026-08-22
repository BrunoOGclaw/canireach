# Methodology and safety contract

## What is measured

For each domain and dialect, v1 records:

- the applicable `robots.txt` verdict;
- HTTP status, redirect count, response time, and final host;
- known challenge/interstitial markers and HTTP 402/toll signals;
- presence of `llms.txt`, `agents.md`, `/.well-known/agents.md`, and Web Bot
  Auth directory signals.

Responses are capped at 12 KiB in memory for fingerprinting and discarded.
The dataset stores no response body, cookies, or general response headers.

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

Requests use modest concurrency, a per-domain delay, bounded redirects, and a
12-second timeout. This is a status probe, not a crawler.

## Vantage

Access decisions are made on IP reputation and network as much as on user-agent,
so the same domain can answer a residential host and a datacentre runner
differently. Every row therefore carries a `vantage` label, and a capture holding
more than one vantage is rejected before publication: a series that quietly
changed where it measured from would show a step change at the switch, and that
step would read as the web changing its policy.

The first baseline (`2026-08-22T0815Z`) predates the field. It was captured from
a residential macOS host; that is recorded here rather than back-filled into the
published rows, because the published bytes are immutable.

Comparisons across vantages are comparisons of two different questions. Only
same-vantage nights are directly comparable.

## What a published capture has been checked for

No capture is published until it passes every gate in `tools/validate.mjs`, and
the gates it passed are published inside its own manifest. They are:

| gate | what it catches |
| --- | --- |
| `json_parse` | a truncated or interrupted append |
| `privacy_shape` | any forbidden key at any depth — bodies, cookies, header maps, presented UA strings |
| `toll_header_shape` | the one exemption (`toll.headers`) being used to smuggle header *values* |
| `domain_coverage` | a run that stopped early but still wrote a file |
| `rows_per_domain` | a domain that produced partial rows, skewing every derived rate |
| `dialect_coverage` | a dialect that silently stopped being probed |
| `run_consistency` | two runs appended into one artifact |
| `vantage_consistency` | two measurement locations merged into one capture |
| `known_outcomes` | the classifier emitting a state the aggregates do not know |
| `instrument_health` | our own outage being published as a collapse in access |

`instrument_health` deserves stating plainly: if fewer than 20% of sent requests
are reachable, the capture is rejected rather than published. A night lost to our
own network is recoverable; a night where our outage is recorded as the web's
behaviour corrupts the baseline this project exists to hold.

Each gate is verified against a capture corrupted specifically to trip it, and
against a clean capture that must pass, so that no gate can go green vacuously
(`tools/test-validate.mjs`).

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
