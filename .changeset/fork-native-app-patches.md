---
"@cloudflare/think": patch
"@cloudflare/voice-signalwire": patch
---

Add `includeCapabilityPrompt` to Think (default `true`); set it to `false` to send the authored system prompt without the capability block. Add `resumed` to `SignalWireAdapterOptions` so a returning stream sends `start_call` with `resumed: true`.
