---
"@cloudflare/voice": patch
---

Add a 750ms debounce (`BARGE_IN_COOLDOWN_MS`) to barge-in. `onSpeechStart → #handleBargeIn` has no confidence or duration floor of its own — any single `StartOfTurn` (background noise, line static, a stray syllable) instantly aborts the active turn. Without a cooldown, a burst of spurious speech-start events can abort a freshly-started turn before it ever produces output, over and over, in a loop. This is upstream Cloudflare behavior (predates this fork) surfaced by live phone testing. The debounce lets a new turn survive for at least 750ms before it can be barge-in'd again; the very first barge-in is unaffected.
