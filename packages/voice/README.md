# @cloudflare/voice

Voice pipeline for [Cloudflare Agents](https://github.com/cloudflare/agents) -- speculative turn detection, persistent streaming TTS, and real-time WebRTC audio.

The published package includes the complete Voice guide at `docs/index.md`.

> **Experimental.** This API is under active development and will break between releases. Pin your version and expect to rewrite when upgrading.

## Install

```bash
npm install @cloudflare/voice
```

## Exports

| Export path                | What it provides                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `@cloudflare/voice`        | Server mixins, the RPC turn adapter, provider types, Workers AI providers, and SFU utilities |
| `@cloudflare/voice/react`  | React hooks (`useVoiceAgent`, `useVoiceInput`)                                               |
| `@cloudflare/voice/client` | Framework-agnostic `VoiceClient` class                                                       |

## Server: full voice agent (`withVoice`)

Adds the complete voice pipeline: continuous STT, LLM turn handling, streaming TTS, interruption, and conversation history that is transient by default. LLM tokens stream straight into the TTS provider so speech can begin before the response completes, and speech start clears active LLM, TTS, and playback work for barge-in.

```typescript
import { Agent } from "agents";
import {
  withVoice,
  WorkersAIFluxSTT,
  WorkersAITTS,
  type VoiceTurnContext
} from "@cloudflare/voice";

const VoiceAgent = withVoice(Agent);

export class MyAgent extends VoiceAgent<Env> {
  transcriber = new WorkersAIFluxSTT(this.env.AI);
  tts = new WorkersAITTS(this.env.AI);

  async onTurn(transcript: string, context: VoiceTurnContext) {
    return "Hello! I heard you say: " + transcript;
  }
}
```

`onTurn()` can also return streaming text, including AI SDK `fullStream` values:

```typescript
import { streamText } from "ai";

async onTurn(transcript: string, context: VoiceTurnContext) {
  const result = streamText({
    model: myModel,
    instructions: "You are a helpful voice assistant. Keep replies short.",
    messages: [
      ...context.messages,
      { role: "user", content: transcript }
    ]
  });

  return result.fullStream;
}
```

### Stream from another Agent over RPC

Use `streamRpcVoiceTurn()` when a separate Agent owns the model turn,
conversation, or tools. The helper passes a Workers `RpcTarget` callback to the
remote Agent, returns its text immediately to Voice, and forwards interruption
to the remote request:

```typescript
import { Think } from "@cloudflare/think";
import {
  streamRpcVoiceTurn,
  type VoiceRpcCallback,
  type VoiceTurnContext
} from "@cloudflare/voice";
import { getAgentByName } from "agents";

export class Brain extends Think<Env> {
  runVoiceTurn(
    transcript: string,
    callback: VoiceRpcCallback
  ): Promise<void> {
    return this.chat(transcript, callback);
  }
}

async onTurn(transcript: string, context: VoiceTurnContext) {
  const brain = await getAgentByName(this.env.BRAIN, this.name);
  return streamRpcVoiceTurn({
    signal: context.signal,
    run: (callback) => brain.runVoiceTurn(transcript, callback),
    cancel: (requestId, reason) => brain.cancelChat(requestId, reason)
  });
}
```

`VoiceRpcCallback.onEvent()` accepts JSON-serialized AI SDK stream events, so it
can be passed directly to Think or another compatible stream producer. A custom
RPC target can instead call `onText()` for each text delta, followed by
`onDone()` or `onError()`. Call `onStart({ requestId })` when the target supports
remote cancellation.

`context.messages` contains completed conversation history before the current transcript. Append `transcript` exactly once when constructing the LLM request. During speculative turns, `onTurn()` runs before confirmation adds the current transcript to history, so `context.messages` is the authoritative snapshot for the request.

Messages exist only for the current Durable Object instance by default. Enable
the original SQLite-backed behavior when messages must survive eviction and
restart:

```typescript
const VoiceAgent = withVoice(Agent, {
  persistMessages: true
});
```

### Provider properties

| Property      | Type          | Required | Description                      |
| ------------- | ------------- | -------- | -------------------------------- |
| `transcriber` | `Transcriber` | Yes      | Continuous per-call STT provider |
| `tts`         | `TTSProvider` | Yes      | Text-to-speech provider          |

### Lifecycle hooks

| Method                             | Description                                                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `onTurn(transcript, context)`      | **Required.** Handle a user utterance. Return `string`, AI SDK `stream`, or `AsyncIterable<string>`.           |
| `createTranscriber(connection)`    | Override to create a transcriber dynamically per connection.                                                   |
| `onCallStart(connection, context)` | Called when a voice call begins. `context.resumed` is `true` after transport recovery.                         |
| `onCallEnd(connection)`            | Called when a voice call ends.                                                                                 |
| `onInterrupt(connection)`          | Called when user interrupts playback, either from client audio-level detection or model-detected speech start. |
| `beforeCallStart(connection)`      | Return `false` to reject a call.                                                                               |
| `onMessage(connection, message)`   | Handle non-voice WebSocket messages (voice protocol is intercepted automatically).                             |

### Barge-in word threshold

```typescript
const VoiceAgent = withVoice(Agent, { minInterruptWords: 3 });
```

Suppresses barge-in for transcripts under the word count -- single-word
backchannels ("yeah", "okay") and short echo fragments no longer cut off
the assistant mid-sentence. Applies to every transcript-bearing trigger
(`flux_speech_start`, `flux_eager_utterance`, `flux_confirmed_utterance`).
Client-side `audio_level` interrupts carry no transcript and are never
gated by this option. `0` (default) disables the gate.

### Pipeline hooks

| Method                                     | Description                                          |
| ------------------------------------------ | ---------------------------------------------------- |
| `afterTranscribe(transcript, connection)`  | Process transcript after STT. Return `null` to skip. |
| `beforeSynthesize(text, connection)`       | Process text before TTS. Return `null` to skip.      |
| `afterSynthesize(audio, text, connection)` | Process audio after TTS. Return `null` to skip.      |

### Convenience methods

- `speak(connection, text)` -- synthesize and send audio to one connection
- `speakAll(text)` -- synthesize and send audio to all connections
- `forceEndCall(connection)` -- programmatically end a call
- `saveMessage(role, content)` -- add a message to conversation history
- `getConversationHistory()` -- retrieve conversation history

## Bidirectional WebRTC audio (`withSFUVoice`)

`withSFUVoice` keeps the voice protocol on the Agent WebSocket while routing
microphone and assistant audio through Cloudflare Realtime SFU:

```typescript
import { Agent } from "agents";
import {
  withSFUVoice,
  WorkersAIFluxSTT,
  WorkersAITTS,
  type SFUConfig
} from "@cloudflare/voice";

const VoiceAgent = withSFUVoice(Agent);

export class MyAgent extends VoiceAgent<Env> {
  transcriber = new WorkersAIFluxSTT(this.env.AI);
  tts = new WorkersAITTS(this.env.AI);

  getSFUConfig(): SFUConfig {
    return {
      appId: this.env.REALTIME_SFU_APP_ID,
      apiToken: this.env.REALTIME_SFU_API_TOKEN
    };
  }

  async onTurn(transcript: string) {
    return `You said: ${transcript}`;
  }
}
```

Pass `SFUVoiceAudioInput` to the framework-agnostic client or React hook. Its
endpoint is the public Agent instance route with `/voice` appended:

```tsx
import { useMemo } from "react";
import { SFUVoiceAudioInput, useVoiceAgent } from "@cloudflare/voice/react";

function App() {
  const audioInput = useMemo(
    () =>
      new SFUVoiceAudioInput({
        endpoint: "/agents/my-agent/alice/voice"
      }),
    []
  );
  const voice = useVoiceAgent({
    agent: "my-agent",
    name: "alice",
    audioInput
  });

  return <button onClick={voice.startCall}>Start call</button>;
}
```

Store `REALTIME_SFU_APP_ID` and `REALTIME_SFU_API_TOKEN` as Worker secrets.
The browser transport uses native echo cancellation, noise suppression, and
automatic gain control.

## Server: voice input only (`withVoiceInput`)

STT-only mixin -- no TTS, no LLM. Use when you only need speech-to-text (e.g., dictation, transcription).

```typescript
import { Agent } from "agents";
import { withVoiceInput, WorkersAINova3STT } from "@cloudflare/voice";

const InputAgent = withVoiceInput(Agent);

export class DictationAgent extends InputAgent<Env> {
  transcriber = new WorkersAINova3STT(this.env.AI);

  onTranscript(text: string, connection: Connection) {
    console.log("User said:", text);
  }
}
```

## Client: React

```tsx
import { useVoiceAgent } from "@cloudflare/voice/react";

function App() {
  const selectedSpeakerId = "default";
  const {
    status, // "idle" | "listening" | "thinking" | "speaking"
    transcript, // TranscriptMessage[]
    interimTranscript, // string | null (real-time partial transcript)
    metrics, // VoicePipelineMetrics | null
    audioLevel, // number (0-1)
    isMuted, // boolean
    connected, // boolean
    error, // string | null
    outputDeviceError, // string | null
    startCall, // () => Promise<void>
    endCall, // () => void
    toggleMute, // () => void
    sendText, // (text: string) => void
    sendJSON // (data: Record<string, unknown>) => void
  } = useVoiceAgent({
    agent: "my-agent",
    // Route assistant playback to a selected audiooutput device when supported.
    outputDeviceId: selectedSpeakerId,
    // Set false to delay connecting until async prerequisites are ready.
    enabled: true
  });

  return <div>Status: {status}</div>;
}
```

When `enabled` is `false`, the hook does not create or connect a `VoiceClient`, returns the idle/disconnected state, and action callbacks such as `startCall()`, `sendText()`, and `sendJSON()` are safe no-ops. The first change from disabled to enabled connects with the current options without firing `onReconnect`; later connection identity changes while enabled do fire `onReconnect`.

`outputDeviceId` accepts a `MediaDeviceInfo.deviceId` from an `audiooutput` device. Browsers without `HTMLMediaElement.setSinkId()` support continue playing through the default output and set `outputDeviceError` for non-default devices. Use `"default"` or `undefined` to return to the system default output. Device labels may be blank until the user grants microphone permission.

For voice input only:

```tsx
import { useVoiceInput } from "@cloudflare/voice/react";

const { transcript, interimTranscript, isListening, start, stop, clear } =
  useVoiceInput({ agent: "DictationAgent" });
```

## Client: vanilla JavaScript

```typescript
import { VoiceClient } from "@cloudflare/voice/client";

const client = new VoiceClient({ agent: "my-agent" });
const selectedSpeakerId = "default";

client.addEventListener("statuschange", () => console.log(client.status));
client.connect();
await client.startCall();

// Switch assistant playback without reconnecting the call.
await client.setOutputDevice(selectedSpeakerId);
```

## Workers AI providers (built-in)

Built-in providers use the Workers AI binding:

| Class               | Type           | Workers AI model       | Recommended for  |
| ------------------- | -------------- | ---------------------- | ---------------- |
| `WorkersAIFluxSTT`  | Continuous STT | `@cf/deepgram/flux`    | `withVoice`      |
| `WorkersAINova3STT` | Continuous STT | `@cf/deepgram/nova-3`  | `withVoiceInput` |
| `WorkersAITTS`      | TTS            | Aura or unified models | Both             |
| `WorkersAIGrokTTS`  | Streaming TTS  | `xai/grok-tts`         | `withVoice`      |

Grok requires a funded AI Gateway Unified Billing balance and an authenticated
`default` gateway.

Grok receives model text deltas directly and returns audio before the model
response completes. It emits 24 kHz mono PCM by default; set
`audioFormat: "mp3"` to expose its raw MP3 WebSocket stream.

Compose a unified Workers AI model with PCM normalization through
configuration:

```typescript
import {
  convertTTSProvider,
  mp3ToPcm16,
  WorkersAITTS
} from "@cloudflare/voice";

const tts = convertTTSProvider({
  provider: new WorkersAITTS(env.AI, {
    model: "elevenlabs/eleven-flash-v2-5",
    input: {
      voice_id: "JBFqnCBsd6RMkjVDRZzb",
      output_format: "mp3_44100_128"
    },
    audioFormat: "mp3"
  }),
  converter: mp3ToPcm16({ sampleRate: 24000 })
});
```

`WorkersAITTS` accepts model-specific input fields and resolves raw audio,
unified audio URLs, and inline data URIs. The conversion wrapper preserves
batch and streaming methods and creates isolated codec state per synthesis.

`WorkersAIFluxSTT` uses Flux `StartOfTurn` events for low-latency barge-in and `EndOfTurn` events for final utterances. Custom transcribers can provide the same behavior by calling `onSpeechStart` from `TranscriberSessionOptions` when user speech begins, then `onUtterance` when the turn is complete.

## Third-party providers

| Package                        | What it provides                                       |
| ------------------------------ | ------------------------------------------------------ |
| `@cloudflare/voice-assemblyai` | Continuous STT (AssemblyAI Universal 3.5 Pro Realtime) |
| `@cloudflare/voice-deepgram`   | Continuous STT (Deepgram Nova)                         |
| `@cloudflare/voice-elevenlabs` | Continuous STT and TTS (ElevenLabs)                    |
| `@cloudflare/voice-telnyx`     | Continuous STT, TTS, and phone transport (Telnyx)      |
| `@cloudflare/voice-twilio`     | Telephony adapter (Twilio Media Streams)               |

## Related

- [`examples/voice-agent`](../../examples/voice-agent) -- full voice agent example with provider toggles
- [`examples/voice-input`](../../examples/voice-input) -- voice input (dictation) example
