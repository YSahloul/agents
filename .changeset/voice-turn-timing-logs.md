---
"@cloudflare/voice-signalwire": patch
"@cloudflare/voice": patch
---

Make a voice call readable in the logs.

`@cloudflare/voice`: the per-turn metrics (`llm_ms`, `tts_ms`, `first_audio_ms`,
`total_ms`) were only sent to the client socket, so nothing explained a slow or
silent reply server-side. They are now also logged as a `turn_complete`
VoiceTrace, an empty model response logs `turn_empty` instead of failing
silently, and the batch/streaming TTS pipeline emits the same trace vocabulary
the realtime pipeline already had (`model_first_delta`, `model_stream_complete`,
`model_stream_error`, `tts_sentence` with per-sentence synth time, and
`tts_first_audio`). Previously that path logged nothing at all.

`@cloudflare/voice-signalwire`: the per-frame `duck` and `gated — dropping`
logs fired ~50×/second while the agent spoke, burying every useful line
(≈700 log lines per call). They are now behind a new `debugAudio` option,
off by default.
