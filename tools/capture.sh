#!/usr/bin/env bash
#
# One night's baseline capture, end to end, safe to run more than once.
#
#   probe -> validate -> manifest -> publish off-host -> verify what was published
#
# IDEMPOTENCE IS AGAINST THE OFF-HOST RECORD, NOT LOCAL DISK. Raw captures are
# gitignored and live on one laptop; the GitHub release is the durable artifact,
# so "has tonight been captured?" is asked of the release list. A local file
# proves nothing about whether the night survived.
#
# This exists because the nightly cron could not be created from inside the
# venture wake job (restricted self-mutation grant). Making the capture
# idempotent means ANY wake landing in the window completes the night, instead of
# the series depending on a scheduler that does not exist yet.
#
# Exit codes carry meaning, because a nightly job that exits 0 having done
# nothing is the failure shape this whole project is about:
#   0  captured and published, or already captured (verified off-host)
#   2  probe failed
#   3  capture rejected by the gates — NOT published
#   4  publish failed, or the published bytes do not match what we built
#   5  refused to run: a capture file for this date already exists locally
#   6  no usable GitHub seat
set -euo pipefail

cd "$(dirname "$0")/.."

DATE="${CANIREACH_DATE:-$(date -u +%Y-%m-%d)}"
TAG="baseline-${DATE}"
LIST="${CANIREACH_LIST:-data/domains/tranco-74V8X-1000.csv}"
OUT="data/probes/${DATE}.jsonl"
MANIFEST="data/probes/${DATE}.manifest.json"
REPO="${CANIREACH_REPO:-BrunoOGclaw/canireach}"
export GH_CONFIG_DIR="${GH_CONFIG_DIR:-$HOME/.config/gh-wakelog}"
export CANIREACH_VANTAGE="${CANIREACH_VANTAGE:-local-residential-macos}"

log() { printf '[capture %s] %s\n' "$DATE" "$*" >&2; }

command -v gh >/dev/null 2>&1 || { log "no gh on PATH"; exit 6; }
gh auth status >/dev/null 2>&1 || { log "gh seat not authenticated (GH_CONFIG_DIR=$GH_CONFIG_DIR)"; exit 6; }

# --- 1. already done? -------------------------------------------------------
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  log "release $TAG already exists off-host; nothing to do"
  exit 0
fi

# --- 2. never append into an existing capture -------------------------------
# The probe appends. A reused path silently merges two runs into one artifact
# that looks like a single night; observed while smoke-testing, so this is a
# guard against something that has actually happened, not a hypothetical.
if [ -e "$OUT" ]; then
  log "REFUSING: $OUT already exists but $TAG is not published. Inspect it, then publish or remove it by hand."
  exit 5
fi

# --- 3. probe ---------------------------------------------------------------
log "probing from vantage '$CANIREACH_VANTAGE'"
if ! node tools/probe.mjs --list "$LIST" --out "$OUT"; then
  log "probe failed"
  exit 2
fi

# --- 4. gates ---------------------------------------------------------------
# A capture that fails is kept on disk for diagnosis and NOT published. Publishing
# a degraded night is worse than a missing one: it is indistinguishable from a
# real collapse in access, which is the exact measurement this series exists for.
if ! node tools/validate.mjs "$OUT" --list "$LIST"; then
  log "capture REJECTED by the gates; kept at $OUT, not published"
  exit 3
fi

node tools/manifest.mjs "$OUT" --list "$LIST" --out "$MANIFEST"
( cd data/probes && shasum -a 256 "${DATE}.jsonl" > "${DATE}.sha256" )

# --- 5. publish -------------------------------------------------------------
NOTES=$(mktemp)
{
  echo "Nightly baseline capture ${DATE}, vantage \`${CANIREACH_VANTAGE}\`."
  echo
  echo "Pre-2026-09-15 access baseline for the top $(grep -c ',' "$LIST") domains. The JSONL is append-only and stores"
  echo "no response bodies, cookies, presented user-agent strings, or generic response-header maps."
  echo "The manifest carries the SHA-256 of both the dataset and the input list, the derived"
  echo "aggregates, and the full list of gates this capture passed."
  echo
  echo "Vendor-token rows are disclosed simulations, not authentic vendor traffic; see METHODOLOGY.md."
} > "$NOTES"

if ! gh release create "$TAG" "$OUT" "$MANIFEST" "data/probes/${DATE}.sha256" \
      --repo "$REPO" --title "Baseline ${DATE}" --notes-file "$NOTES"; then
  log "publish failed"
  rm -f "$NOTES"
  exit 4
fi
rm -f "$NOTES"

# --- 6. verify the published bytes ------------------------------------------
# "Uploaded" is not "published". Download what the world will get and compare it
# to what we built; a truncated upload that reports success is the same silent
# failure one layer out.
VERIFY=$(mktemp -d)
if ! gh release download "$TAG" --repo "$REPO" --pattern '*.jsonl' --dir "$VERIFY" >/dev/null 2>&1; then
  log "could not download the release we just created"
  rm -rf "$VERIFY"
  exit 4
fi
LOCAL_HASH=$(shasum -a 256 "$OUT" | cut -d' ' -f1)
REMOTE_HASH=$(shasum -a 256 "$VERIFY/${DATE}.jsonl" | cut -d' ' -f1)
rm -rf "$VERIFY"
if [ "$LOCAL_HASH" != "$REMOTE_HASH" ]; then
  log "PUBLISHED BYTES DIFFER: local $LOCAL_HASH vs remote $REMOTE_HASH"
  exit 4
fi

log "published $TAG and verified off-host: $LOCAL_HASH"
exit 0
