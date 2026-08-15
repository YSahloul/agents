---
"@cloudflare/voice": minor
---

Add `WorkersAIGrokTTS` for streaming xAI Grok text-to-speech through the
Workers AI binding, with incremental MP3-to-PCM conversion for voice
transports.
Add bidirectional model-text streaming so Grok can emit audio before the model
response completes.
Bound long model sentences into speech-ready phrases so streaming providers
start synthesizing before the sentence finishes generating.
