---
"@cloudflare/voice": minor
---

Restore the upstream `StreamingTTSProvider` surface that an earlier removal
(`remove-dead-tts-providers`) dropped. That removal assumed the interface had
no consumers, but `voice-providers/elevenlabs` and `voice-providers/telnyx`
both `import { StreamingTTSProvider } from "@cloudflare/voice"` and
`implements` it — so the removal broke both with TS2305, and transitively
`examples/telnyx-voice-agent`.

- Re-export `StreamingTTSProvider` (and its `synthesizeStream` member) from
  `@cloudflare/voice`.
- Re-add the `hasStreamingTTS` / `synthesizeStream` branch in the voice
  pipeline's per-sentence TTS generator. The realtime-session dispatcher keeps
  precedence, so this only runs when the provider implements
  `synthesizeStream` and has no `createSession`.

Also restore the upstream `eagerEotThreshold` / `EagerEndOfTurn` /
`TurnResumed` STT plumbing on `WorkersAIFluxSTT` (option, class wiring, Flux
session config, event union, `#connect` enrichment, `#handleMessage` cases) —
restored as the optional upstream knob; nothing in the fork consumes the
events.

No fork additions are removed. `WorkersAIMulawRealtimeTTS`, the SFU stack, and
the SignalWire adapter are untouched.
