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

