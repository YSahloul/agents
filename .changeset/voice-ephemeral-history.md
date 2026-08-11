---
"@cloudflare/voice": minor
---

Keep `withVoice` conversation history in memory instead of automatically writing transcripts to Durable Object SQLite.

Confirmed user and assistant messages remain available through `context.messages`, `saveMessage()`, and `getConversationHistory()` for the active agent instance. History is cleared by Durable Object eviction or restart. Applications that require durable call records must persist them explicitly from their lifecycle hooks.
