---
"@cloudflare/voice": minor
---

Add `mulaw` encoding to `WorkersAIRealtimeTTS` (with an 8 kHz guard) and widen `VoiceAudioFormat` so a phone leg can request 8 kHz μ-law over the Speak WebSocket with zero resampling. Make the realtime TTS session self-healing: the Workers AI Speak WebSocket closes itself after ~10 s idle (and ignores `KeepAlive` pings on the binding path), so the session now transparently reconnects on unexpected close — resetting the readiness gate so the next turn blocks on the fresh socket instead of throwing "WebSocket is not open" and bricking the rest of the call. A 5 s `KeepAlive` heartbeat is also sent as a first line of defense.
