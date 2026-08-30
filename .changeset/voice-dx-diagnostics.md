---
"@cloudflare/voice": minor
"@cloudflare/voice-assemblyai": minor
"@cloudflare/voice-elevenlabs": minor
"@cloudflare/voice-deepgram": minor
"@cloudflare/voice-telnyx": minor
"@cloudflare/voice-plivo": patch
"@cloudflare/voice-twilio": patch
---

Realign Voice with the upstream diagnostics lifecycle while preserving the fork's production transports, streaming providers, interruption behavior, and public root API.

- Add the `@cloudflare/voice/errors` subpath, sanitized browser diagnostics, structured Worker errors, fatal transcriber reporting, completion outcomes, and stable per-turn model/TTS metrics.
- Restore `voice.ts` as the primary implementation and use a package-only barrel to keep SFU, RPC, and audio-converter exports cycle-free without changing `@cloudflare/voice`.
- Keep Flux eager-turn confirmation, transcript-threshold barge-in, assistant-echo filtering, server audio transports, playback-marker acknowledgements, and acknowledged playback text integrated with diagnostic turn cleanup.
- Keep durable SQLite conversation history as the default while allowing session-owning integrations such as Think to select bounded in-memory history with `persistMessages: false`.
- Update VoiceClient, React hooks, Voice Input, Workers AI providers, and bundled provider packages to report lifecycle failures and structured errors consistently.
