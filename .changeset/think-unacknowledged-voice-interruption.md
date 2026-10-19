---
"@cloudflare/think": patch
---

Reconcile interrupted voice turns even when playback acknowledgements are unavailable. Remove unacknowledged assistant text before the next voice turn while preserving completed tool results and prior confirmed history when an eager draft is rejected.
