#!/usr/bin/env bash
# Capture worker logs as JSON to a stable path, and echo the lines that matter.
#
#   scripts/tail.sh            # capture + live view
#   node scripts/calls.mjs     # per-turn timeline of the last call
#
# The full JSON (including media frames) lands in $CAPTURE so calls.mjs can
# reconstruct exact timings after the fact. The live view here is only a
# convenience — it drops the per-frame media spam.
cd "$(dirname "$0")/.." || exit 1
CAPTURE="${CAPTURE:-/tmp/signalwire-calls.json}"
: >"$CAPTURE"
echo "capturing to $CAPTURE — read it with: node scripts/calls.mjs"
exec ../../node_modules/.bin/wrangler tail --format json \
  | tee -a "$CAPTURE" \
  | grep -E '"(event|message)"' \
  | grep -Ev 'duck|Unknown Event|getWebSocketEvent'
