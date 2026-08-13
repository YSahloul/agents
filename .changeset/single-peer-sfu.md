---
"@cloudflare/voice": patch
---

Use one browser WebRTC peer and one Realtime SFU session for microphone publishing and agent audio playback, request mono microphone capture for acoustic echo cancellation, prime the TTS track before the browser subscribes, and preserve PCM sample alignment across streaming chunks.
