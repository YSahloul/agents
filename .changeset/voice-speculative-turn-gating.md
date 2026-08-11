---
"@cloudflare/voice": patch
---

Gate eager end-of-turn drafts until the transcriber confirms the caller's turn.

The voice pipeline still starts transcript processing and model work on eager
end-of-turn, but it now withholds transcripts, TTS, audio, and persistence until
final confirmation. Resumed speech and teardown abort the draft silently, final
transcript mismatches restart from the confirmed text, and eager speech can
force-interrupt confirmed playback even during the raw speech-start cooldown.
