---
"@cloudflare/voice": patch
---

Fix Flux STT `TurnResumed` state handling. Two defects in the turn state
machine (inherited from upstream, exercised once the eager end-of-turn
threshold is set):

- `TurnResumed` with an empty transcript no longer wipes the accumulated
  `#currentTranscript` — previously an eager end-of-turn followed by the model
  hearing the user keep talking collapsed `EndOfTurn` to a fragment
  ("the star level.") or nothing.
- `TurnResumed` now re-fires `onSpeechStart`, so resumed speech after an eager
  end-of-turn triggers barge-in instead of the agent talking over the user.
