---
"@cloudflare/voice": minor
---

Remove the dead TTS providers and the streaming-TTS abstraction they were the
sole implementers of:

- `WorkersAIMulawTTS` (batch HTTP μ-law) — unused by any example or test; the
  SignalWire phone leg uses `WorkersAIMulawRealtimeTTS` instead.
- `WorkersAIRealtimeTTS` + `WorkersAIRealtimeTTSSession` (persistent Aura
  WebSocket, keepalive + reconnect) — abandoned first realtime attempt; the
  WebRTC example switched to batch `WorkersAITTS`.
- `StreamingTTSProvider` interface + `synthesizeStream` — the only implementer
  was `WorkersAIMulawTTS`; with it gone the interface has no consumers and the
  `hasStreamingTTS` branch in the voice pipeline is dead.

BREAKING: the exports `WorkersAIMulawTTS`, `WorkersAIRealtimeTTS`,
`WorkersAIMulawTTSOptions`, `WorkersAIRealtimeTTSOptions`, and
`StreamingTTSProvider` are removed from `@cloudflare/voice`.

The live TTS surface is unchanged: `WorkersAITTS` (batch) and
`WorkersAIMulawRealtimeTTS` (phone realtime). Barge-in, Flux/Nova 3 STT, the
SFU stack, and the SignalWire adapter are untouched.
