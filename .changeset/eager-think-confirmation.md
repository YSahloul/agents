---
"agents": patch
"@cloudflare/think": patch
---

Pass speculative voice turn confirmation to the model adapter. Think starts inference with transient input, then commits the transcript and releases tool execution only when the transcriber confirms end-of-turn. Rejected hypotheses leave session history untouched instead of rolling back committed messages. Interrupting confirmed voice playback no longer cancels an in-progress tool; tool results persist while unspoken assistant text is discarded.
