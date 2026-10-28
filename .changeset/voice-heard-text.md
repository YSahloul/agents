---
"agents": patch
"@cloudflare/think": patch
---

Voice: when a caller interrupts, keep only the part of the assistant reply that played. For raw `pcm16`/`mulaw` output, a playback clock maps sent audio to text (whole sentences plus whole words of the current sentence); history stores that text, and `onInterrupt(connection, context)` receives it as `context.heardText`. Think persists it as an interrupted message, keeping tool results.
