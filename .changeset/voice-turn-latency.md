---
"agents": patch
---

Voice: log one `[VoiceLatency]` record per speech turn, measured the way Pipecat and LiveKit do: from the user stopping speaking (inbound PCM energy) to the agent's first audio, on the agent's clock, with `end_of_turn_delay_ms`, `llm_ttft_ms`, `tts_ttfb_ms` and stages that add up to `e2e_latency_ms`. The `tts_enqueued` trace no longer carries `elapsedMs`.
