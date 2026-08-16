---
"@cloudflare/voice": minor
---

Add `WorkersAIGrokTTS` for streaming xAI Grok text-to-speech through the
Workers AI binding. Extend `WorkersAITTS` for unified model inputs and audio
responses. Add reusable MP3-to-PCM conversion, provider composition, and an
optional client-side SFU microphone noise gate.
Add bidirectional model-text streaming so Grok can emit audio before the model
response completes.
Bound long model sentences into speech-ready phrases so streaming providers
start synthesizing before the sentence finishes generating.
