---
"@cloudflare/voice": minor
---

Make `withVoice` conversation history transient by default while preserving the original Durable Object SQLite behavior behind `persistMessages: true`.

Confirmed user and assistant messages remain available through `context.messages`, `saveMessage()`, and `getConversationHistory()`. With the default `persistMessages: false`, history exists only for the current Durable Object instance. Set `persistMessages: true` when messages must survive eviction and restart.
