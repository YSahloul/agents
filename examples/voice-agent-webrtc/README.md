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

Workers AI provides Flux turn detection, realtime Aura TTS, and the selectable
LLM models.

## Key pattern

The server uses realtime Workers AI Aura TTS with PCM16 audio at 24 kHz:

```ts
const VoiceAgent = withSFUVoice(Agent);

export class MyVoiceAgent extends VoiceAgent<Env> {
  tts = new WorkersAIRealtimeTTS(this.env.AI, {
    model: "@cf/deepgram/aura-2-en",
    speaker: "draco",
    encoding: "linear16",
    sampleRate: 24000
  });
  transcriber = new WorkersAIFluxSTT(this.env.AI, {
    eotThreshold: 0.7,
    eagerEotThreshold: 0.7
  });

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
