---
"@cloudflare/voice": patch
---

Fix a real-world regression in the SFU reconnection resilience added
previously: the client's `#recoverCall` fast path (taken when the
`RTCPeerConnection` still reports `connected`/`connecting`) sent
`resumed:true` and just hoped the server-side resume succeeded. WebRTC ICE
failure detection is often much slower than the control WebSocket's own
reconnect, so the peer can still look "connected" well after the SFU's 30s
grace window has expired server-side -- leaving `resume()` to hang for the
full 10s TTS-callback timeout and then fail the call outright, with no
retry. From the user's perspective this looked like "it just doesn't
reconnect" and required a manual refresh or re-click to recover.

- `SFUVoiceTransport.resume()` now fails immediately (instead of waiting out
  the full 10s TTS-socket timeout) when there is no persisted session to
  resume.
- `VoiceClient#recoverCall`'s fast path now waits (bounded, 5s) for the
  server to confirm the resume (`status: "listening"`) before considering it
  done. If the server instead reports failure (`status: "idle"`) or the wait
  times out, the client automatically falls through to the existing full
  media rebuild instead of leaving the call dead.
