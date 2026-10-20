---
"agents": patch
"@cloudflare/think": patch
---

Use Think's existing assistant persistence and turn queue for interrupted voice replies instead of waiting for a turn and rewriting the latest history entry. Preserve running tool results, keep eager confirmation unchanged, and target the owning saved message when playback is interrupted after generation finishes. Notify the interruption hook without waiting for asynchronous transport clearing.
