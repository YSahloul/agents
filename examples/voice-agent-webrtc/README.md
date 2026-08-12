# WebRTC Voice Agent

A real-time, bidirectional voice agent using the reusable voice pipeline and
WebRTC transport from `@cloudflare/voice`. LLM tokens stream straight into TTS as they arrive,
and microphone plus assistant audio travel through Cloudflare Realtime SFU.

## Run it

```bash
pnpm install
cp .env.example .env
pnpm run start
```

Set the required Realtime SFU credentials in `.env`:

```bash
REALTIME_SFU_APP_ID=...
REALTIME_SFU_BEARER_TOKEN=...
```

To use ElevenLabs TTS, set its optional API key:

```bash
ELEVENLABS_API_KEY=...
```

Workers AI provides Flux turn detection, the default Aura TTS provider, and
the selectable LLM models. ElevenLabs is available as an optional TTS provider.

## Key pattern

The server keeps the default Aura provider on its original path. Only an
explicit ElevenLabs selection replaces it for that call:

```ts
const VoiceAgent = withSFUVoice(Agent);

export class MyVoiceAgent extends VoiceAgent<Env> {
  tts = new WorkersAITTS(this.env.AI, {
    model: "@cf/deepgram/aura-2-en",
    speaker: "draco",
    encoding: "linear16",
    container: "none",
    sampleRate: 24000
  });
  readonly #auraTts = this.tts;
  transcriber = new WorkersAIFluxSTT(this.env.AI, {
    eotThreshold: 0.7
  });

  beforeCallStart(connection: Connection) {
    this.tts = createElevenLabsVoiceTTS(connection, this.env) ?? this.#auraTts;
    return true;
  }

  getSFUConfig() {
    return {
      appId: this.env.REALTIME_SFU_APP_ID,
      apiToken: this.env.REALTIME_SFU_BEARER_TOKEN
    };
  }
}
```

The React client gives `useVoiceAgent` the library-owned WebRTC audio input:

```tsx
const audioInput = useMemo(
  () =>
    new SFUVoiceAudioInput({
      endpoint: `/agents/my-voice-agent/${sessionId}/voice`
    }),
  [sessionId]
);

const voice = useVoiceAgent({
  agent: "my-voice-agent",
  name: sessionId,
  audioInput
});
```

There is no PCM-over-WebSocket fallback or example-owned SFU implementation.
