---
"@cloudflare/voice": minor
---

Add `WorkersAIMulawTTS`: a phone-leg TTS provider that streams native 8 kHz μ-law over the Workers AI binding's HTTP path — the one path that actually honors `encoding: "mulaw"` (the WebSocket/realtime path ignores it and always emits linear16, which garbled when passed through as μ-law). This is the proven pattern ported from a production phone agent, so `withVoice`-based phone examples can consume it from the library instead of carrying a local copy.

`synthesizeStream` is temporarily batch-only (synthesizes the full sentence, then yields it as one chunk) instead of true HTTP-body frame streaming. Live phone testing showed real 20 ms-frame streaming produced garbled audio on the carrier leg; batching per sentence fixed it immediately. Root cause of the frame-streaming garble is not yet isolated (candidates: the per-frame `afterSynthesize` hook, or how the streaming pipeline paces small chunks to the carrier) — tracked as follow-up. This costs some latency (audio starts after each full sentence synthesizes, not as it streams in) but is correct today.
