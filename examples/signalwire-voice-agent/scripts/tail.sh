#!/usr/bin/env bash
# Filtered wrangler tail — drops the bidirectional-stream "Unknown Event" spam
# (every cXML media frame logs as one), keeps console.log / request / error
# lines. Mirrors voice-app's scripts/capture-logs.sh noise filtering.
cd "$(dirname "$0")/.." || exit 1
exec ../../node_modules/.bin/wrangler tail --format pretty | grep -v "Unknown Event"
