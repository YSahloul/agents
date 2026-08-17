---
"@cloudflare/voice": minor
---

Add SFU reconnection resilience so media survives brief control-plane drops
and idle TTS tracks stop getting garbage-collected.

- `SFUVoiceTransport` gains `suspend()`/`resume()`: a control-WebSocket close
  now suspends the transport for a 30s grace window (matching the SFU's
  track/session reuse window) instead of tearing down the SFU session
  immediately. A reconnect within the window re-attaches to the retained TTS
  socket and adapters instead of re-running the full 6-step SFU handshake.
- `SFUVoiceTransport` sends a silent 20ms keepalive frame on the TTS track
  every 20s when idle, preventing the SFU's 30s no-media track timeout from
  killing the track during silence.
- `SFUVoiceAudioInput` gains `isConnected()` and `onConnectionLost`;
  `VoiceClient` skips the client-side media rebuild on reconnect when the
  `RTCPeerConnection` never dropped, and proactively recovers the call when
  the peer connection itself fails or stays disconnected for more than 5s
  (independent of the control WebSocket).
- Add `updateSFUTracks()` and `getSFUSession()` helpers to `sfu-utils`,
  exported from the package root alongside the existing SFU helpers.
