---
"@cloudflare/voice": minor
---

Add configurable Voice conversation persistence while keeping Durable Object SQLite history as the default.

Set `persistMessages: false` when another layer, such as Think Session, owns durable conversation history. The opt-out retains bounded in-memory messages for `context.messages`, `saveMessage()`, and `getConversationHistory()` without creating the Voice history table.
