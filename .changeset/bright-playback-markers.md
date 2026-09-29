---
"agents": patch
"@cloudflare/think": patch
"@cloudflare/voice-signalwire": patch
---

Add acknowledged playback checkpoints for SignalWire calls, reconcile interrupted Think responses to speech the caller heard, preserve carrier-rate pacing for buffered audio bursts, and keep continuous inbound audio for barge-in.
