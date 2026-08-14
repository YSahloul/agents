#!/usr/bin/env bash
set -o pipefail
cd "$(dirname "$0")/.." || exit 1
WORKER="${WORKER:-signalwire-mcp-voice-agent-example}"
RAW="${RAW:-/tmp/signalwire-mcp-calls.json}"
CLEAN="${CLEAN:-/tmp/signalwire-mcp-calls.jsonl}"
PRETTY="${PRETTY:-/tmp/signalwire-mcp-calls.pretty.json}"
touch "$RAW" "$CLEAN" "$PRETTY"
echo "worker: $WORKER"
echo "raw: $RAW"
echo "structured JSONL: $CLEAN"
echo "pretty JSON: $PRETTY"
STARTED="$(
  jq -nc --arg timestamp "$(date -u +%FT%TZ)" \
    '{ timestamp: $timestamp, source: "capture", event: "started" }'
)"
printf '%s\n' "$STARTED" >>"$CLEAN"
printf '%s\n' "$STARTED" | jq . >>"$PRETTY"
exec ../../node_modules/.bin/wrangler tail "$WORKER" --format json \
  | tee -a "$RAW" \
  | jq --unbuffered -c '
      (
        .logs[]?
        | select(
            .level == "error"
            or (.message[0]? == "[VoiceTrace]")
            or (.message[0]? == "[MCPTrace]")
          )
        | if .level == "error" then
            {
              timestamp: .timestamp,
              source: "worker",
              event: "error",
              message: .message
            }
          else
            {
              timestamp: .timestamp,
              source: (
                if .message[0] == "[MCPTrace]" then "mcp_tool"
                else "voice"
                end
              ),
              data: (
                .message[1]
                | walk(
                    if type == "object"
                      and .type? == "text"
                      and (.text? | type) == "string"
                    then
                      .text as $text
                      | .text = (try ($text | fromjson) catch $text)
                    else .
                    end
                  )
              )
            }
          end
      ),
      (
        .exceptions[]?
        | {
            timestamp: (.timestamp // null),
            source: "worker",
            event: "exception",
            message: .message
          }
      ),
      (
        .diagnosticsChannelEvents[]?
        | select(.channel == "agents:mcp")
        | {
            timestamp: .timestamp,
            source: "mcp_lifecycle",
            channel: .channel,
            data: .message
          }
      ),
      (
        . as $event
        | select(.event.request? != null)
        | .event.request as $request
        | ($request.headers["mcp-method"] // "") as $method
        | select(($request.url | endswith("/answer")) or $method != "")
        | {
            timestamp: $event.eventTimestamp,
            source: "http",
            method: $request.method,
            url: $request.url,
            status: $event.event.response.status,
            mcp: (
              if $method == "" then null
              else {
                method: $method,
                tool: ($request.headers["mcp-name"] // null)
              }
              end
            )
          }
      )
    ' \
  | tee -a "$CLEAN" \
  | jq --unbuffered . \
  | tee -a "$PRETTY"
