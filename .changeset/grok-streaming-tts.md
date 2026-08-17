---
"@cloudflare/voice": minor
---

Add `WorkersAIGrokTTS` for streaming xAI Grok text-to-speech through the
Workers AI binding. Extend `WorkersAITTS` for unified model inputs and audio
responses.
Add reusable MP3-to-PCM conversion and provider composition.
Include client-captured STT turn RMS values in Voice traces without
continuous level logging.
Mark recovered calls in `onCallStart` so reconnect initialization can run
without replaying new-call side effects such as greetings.
Add bidirectional model-text streaming so Grok can emit audio before the model
response completes.
Bound long model sentences into speech-ready phrases so streaming providers
start synthesizing before the sentence finishes generating.
