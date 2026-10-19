---
"agents": patch
---

Always stop voice playback and notify the interruption hook on speech start, even after local generation has finished and no aligned playback state remains. This lets transports clear queued carrier audio without changing Think or tool execution.
