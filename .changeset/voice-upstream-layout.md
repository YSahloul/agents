---
"agents": patch
---

Move the voice mixin back into `agents/voice/index.ts` to match upstream. Remove `withSFUVoice` and `SFUVoiceAgentOptions`; compose with `withSFUVoiceTransport(withVoice(Agent, { audioFormat: "pcm16", sampleRate: 24000 }))` instead.
