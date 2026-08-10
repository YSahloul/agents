---
"@cloudflare/voice": minor
---

Remove the speculative eager-end-of-turn pipeline from `withVoice`. The voice
pipeline now runs only on a confirmed `EndOfTurn` — there is no longer an
early `#startSpeculativeTurn` kick or a `TurnResumed` cancellation.

BREAKING: the following public API surface is removed because it existed solely
to feed speculative inference and now has no consumer:

- `TranscriberSessionOptions.onEagerUtterance`
- `TranscriberSessionOptions.onTurnResumed`
- `WorkersAIFluxSTTOptions.eagerEotThreshold`

The Flux STT session no longer requests `eager_eot_threshold` from the model,
so `EagerEndOfTurn`/`TurnResumed` events are never emitted. `Update`/`EndOfTurn`
turn detection, barge-in handling, and realtime TTS streaming are unchanged.
