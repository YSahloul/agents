---
"@cloudflare/voice": patch
"@cloudflare/think": patch
---

Track SFU playback text at TTS sentence boundaries so interrupted Think voice turns persist only committed speech, while keeping transport interruption safe across stale or closed lifecycle races.
