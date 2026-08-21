# Avatar WebRTC Voice Agent

A single Think Durable Object that owns Session state, Voice STT/TTS, Cloudflare Realtime SFU/WebRTC, tools, and a persistent workspace.

The browser animates a local robot while SFU playback audio is audible. It also shows the retained Researcher sub-agent's live status and final summary beside the shared transcript. Only audio travels through the SFU; the frames are generic animation, not visemes.

## Run it

```bash
pnpm install
cp .env.example .env
pnpm run start
```

The deployed example is available at [`think.sahloul.io`](https://think.sahloul.io).

Set the required Realtime SFU credentials in `.env` for local development:

```bash
REALTIME_SFU_APP_ID=...
REALTIME_SFU_BEARER_TOKEN=...
```

For deployment, set both values with `pnpm exec wrangler secret put <NAME>`. Never commit them.

Workers AI provides Flux turn detection, selectable LLMs, and Grok TTS through the unified model catalog. No direct xAI API key is required; AI Gateway Unified Billing must be funded.

## Key pattern

`createSFUVoiceThink()` composes Think, Voice, and SFU transport on one Durable Object. `voiceChannel()` supplies the STT/TTS providers and voice policy:

```ts
import { createSFUVoiceThink, voiceChannel } from "@cloudflare/think/voice";
import {
  convertTTSProvider,
  mp3ToPcm16,
  WorkersAIFluxSTT,
  WorkersAIGrokTTS
} from "@cloudflare/voice";

const VoiceThink = createSFUVoiceThink<Env>();

export class MyThinkAgent extends VoiceThink {
  configureChannels() {
    return {
      voice: voiceChannel({
        transcriber: new WorkersAIFluxSTT(this.env.AI, {
          eotThreshold: 0.7
        }),
        tts: convertTTSProvider({
          provider: new WorkersAIGrokTTS(this.env.AI, {
            voice: "ara",
            audioFormat: "mp3"
          }),
          converter: mp3ToPcm16({ sampleRate: 24000 })
        }),
        instructions: "Keep replies concise, natural, and speakable.",
        maxTurns: 3
      })
    };
  }

  getSFUConfig() {
    return {
      appId: this.env.REALTIME_SFU_APP_ID,
      apiToken: this.env.REALTIME_SFU_BEARER_TOKEN
    };
  }
}
```

Each confirmed transcript enters inherited `runTurn({ channel: "voice", mode: "stream" })`. Think text deltas flow directly to SFU TTS. Barge-in aborts the same Think turn through `VoiceTurnContext.signal`; no RPC bridge or second Durable Object is involved. Think Session remains the only durable conversation history.

`getVoiceTurnMetadata()` validates the connection's `llm` and `reasoning` query parameters and stamps them on the user message. `beforeTurn()` reads `activeTurnMetadata`, so model selection survives recovery.

The browser uses the same named agent for voice, tool events, and workspace RPC:

```tsx
const thinkAgent = useAgent({
  agent: "my-think-agent",
  name: sessionId
});

const audioInput = new SFUVoiceAudioInput({
  endpoint: `/agents/my-think-agent/${encodeURIComponent(sessionId)}/voice`
});

const voice = useVoiceAgent({
  agent: "my-think-agent",
  name: sessionId,
  audioInput
});
```

The Think workspace tools can create, read, update, search, and delete durable files. Shell execution stays disabled. `research_background` dispatches a detached retained `Researcher`; its simulated `web_search` demonstrates orchestration, not grounded internet research.

`[ThinkTrace]` logs turn timing, step usage, and server-side tool activity. `[VoiceTrace]` logs STT timing and captured RMS data. Reasoning text remains hidden before display and TTS.

There is no PCM-over-WebSocket fallback or example-owned SFU implementation.

The robot frames are adapted from [`pipecat-ai/pipecat-examples`](https://github.com/pipecat-ai/pipecat-examples/tree/main/simple-chatbot/server/assets) under the BSD 2-Clause License.
