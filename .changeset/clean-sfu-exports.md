---
"@cloudflare/voice": patch
---

Export `withSFUVoiceTransport` reliably by removing the circular dependency between the public voice entry point and the SFU mixin.
