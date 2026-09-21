---
"@cloudflare/voice": minor
---

Add `onPlaybackStream` and `playbackDelayMs` to `SFUVoiceAudioInputOptions`.

`onPlaybackStream` hands the caller the assistant's remote SFU audio stream
alongside the existing `onPlaybackAudioLevel`, so a local renderer can react to
the same audio the user hears — lip-sync, visemes, or amplitude animation —
without re-capturing playback or reaching into the peer connection. The stream
is emitted from the existing `peer.ontrack` handler and is replaced whenever the
connection renegotiates, so callers must re-attach on each call.

`playbackDelayMs` holds playback back through a `DelayNode` before it reaches
the output device. Audio-driven lip-sync has to classify a phoneme before it can
move the mouth, so visemes trail the audio by roughly 50-100ms; delaying the
audio by the same amount lines the two up. `onPlaybackStream` still receives the
undelayed stream, so a detector reading it is not delayed twice. The graph lives
on the analyser context and is torn down with the call.

Both default to the previous behaviour: no stream callback, no delay.
