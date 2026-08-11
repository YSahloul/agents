---
"@cloudflare/voice": minor
---

Rebuild WebSocket TTS on the upstream `StreamingTTSProvider` shape.

`WorkersAIMulawRealtimeTTS` now implements `synthesizeStream(text, signal)`
(`AsyncGenerator<ArrayBuffer>`) — one socket per sentence, the generator
returning _is_ completion. The Speak/Flush/Clear session protocol
(`RealtimeTTSProvider`/`RealtimeTTSSession`/`RealtimeTTSSessionOptions`,
`#flushWaiters`, connect-on-use + `#connecting` dedupe, the frame-delivery
promise chain) is deleted along with `#realtimeTTSPipeline`, the per-connection
session maps, and the `#speakText` realtime branch in the voice runtime.

Behavior preserved: 160-byte μ-law framing (Aura sends arbitrary transport
fragments) and 20 ms real-time pacing, first frame immediate.

Why: a session held open across a call had no way to surface a dead socket
mid-turn — `flush()` only settled on the server's `Flushed` acknowledgement,
so a 1011 close left `await flush()` pending forever and the agent silent for
the rest of the call. An async generator throws into the consumer's `for await`
instead, which the pipeline already catches, logs, and recovers from; the next
sentence reconnects on demand. `audioFormat`/`sampleRate` moved onto
`TTSProvider` so `audio_config` still announces the μ-law/8000 contract.
