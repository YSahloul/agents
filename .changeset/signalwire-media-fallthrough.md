---
"@cloudflare/voice-signalwire": patch
---

Fix inbound audio being forwarded twice per frame.

The `media` case in the carrier message handler had no `return`, so after
sending the decoded PCM frame it fell through to the `dtmf` case and sent the
same frame again as a JSON media event (base64 payload included). At 20 ms
frames that doubled the agent's inbound WebSocket message rate — roughly 50
extra Durable Object invocations per second per call, each carrying a payload
the voice runtime parses and discards.
